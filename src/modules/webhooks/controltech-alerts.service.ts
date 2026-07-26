/**
 * Controltech EA alert intake — shared by the webhook receiver
 * (webhooks.controller) and the sync:alerts backfill script.
 *
 * The provider pushes pre-composed operational alerts about dispatch and
 * driver governance:
 *
 *   TRACTOR_OVERDUE           — a dispatched unit is past its expected return
 *   DRIVER_BLOCKED            — a driver was refused dispatch
 *   DRIVER_ASSIGNMENT_CHANGED — a unit went out with someone other than its
 *                               assigned driver
 *   HOTO_DISCREPANCY          — handover/takeover mismatch
 *
 * The payload has no severity and no vehicle id — just a human-readable
 * `message` with the plate inline. We classify severity from `type`, recover
 * the vehicle by parsing the plate (best-effort: an alert about a person has
 * none), and keep the provider's own wording as the feed text rather than
 * rewriting it.
 *
 * Idempotent: rows are upserted on the provider's alert id, so a webhook
 * redelivery (or a backfill overlapping live traffic) never duplicates. Only
 * genuinely new alerts are pushed to the live feed.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardFeed, emitDashboardAlert } from '../../lib/sse.js'
import { parseProviderTimeOr } from '../../lib/provider-time.js'

/** Provider factoryCode → our organisation code (mirrors the sync scripts). */
const FACTORY_TO_ORG: Record<string, string> = {
  NDHIWA: 'SUKARI',
}

/** Alert type → live-feed severity. Unknown types default to `info`. */
const SEVERITY_BY_TYPE: Record<string, 'info' | 'warning' | 'critical'> = {
  TRACTOR_OVERDUE:           'warning',
  DRIVER_BLOCKED:            'critical',
  HOTO_DISCREPANCY:          'warning',
  DRIVER_ASSIGNMENT_CHANGED: 'info',
}

export interface ControltechAlert {
  id:           string
  factoryCode:  string
  type:         string
  message:      string
  relatedId?:   string | null
  acknowledged?: boolean | null
  /** NULL on webhook deliveries — only the REST backfill populates it. */
  createdAt?:   string | null
}

// Kenyan plate formats seen in the fleet: KBU 123A, KTCB 814H, KHMA 603F.
// Matched case-insensitively with an optional space so "kcx799s" still resolves.
const PLATE_RE = /\b([A-Z]{2,4})\s?(\d{3})\s?([A-Z])\b/i

export function extractPlate(message: string): string | null {
  const m = PLATE_RE.exec(message)
  return m ? `${m[1]!.toUpperCase()} ${m[2]}${m[3]!.toUpperCase()}` : null
}

export function severityOf(type: string): 'info' | 'warning' | 'critical' {
  return SEVERITY_BY_TYPE[type] ?? 'info'
}

const orgIdCache = new Map<string, string | null>()

async function resolveOrgId(factoryCode: string): Promise<string | null> {
  if (orgIdCache.has(factoryCode)) return orgIdCache.get(factoryCode) ?? null
  const code = FACTORY_TO_ORG[factoryCode]
  if (!code) { orgIdCache.set(factoryCode, null); return null }
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  orgIdCache.set(factoryCode, org?.id ?? null)
  return org?.id ?? null
}

export interface IngestResult {
  created: number
  updated: number
  skipped: number   // unmapped factory code
}

/**
 * Persist a batch of provider alerts and push the NEW ones to the live feed.
 *
 * @param source 'webhook' when pushed to us, 'backfill' when pulled.
 * @param emit   false suppresses the live-feed push — used when backfilling
 *               history so a one-off catch-up doesn't flood the feed.
 */
export async function ingestAlerts(
  alerts: ControltechAlert[],
  source: 'webhook' | 'backfill' = 'webhook',
  emit = true,
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, updated: 0, skipped: 0 }

  for (const a of alerts) {
    const organisationId = await resolveOrgId(a.factoryCode)
    if (!organisationId) {
      result.skipped++
      logger.warn({ factoryCode: a.factoryCode, alertId: a.id }, 'Provider alert for an unmapped factory — skipped')
      continue
    }

    const plate     = extractPlate(a.message)
    const severity  = severityOf(a.type)
    // Live webhook alerts carry no timestamp — they ARE happening now, so the
    // receive time is the honest stand-in. Backfilled ones carry an offsetless
    // EAT stamp (see lib/provider-time).
    const createdAt = parseProviderTimeOr(a.createdAt)

    const vehicle = plate
      ? await prisma.vehicle.findFirst({
          where:  { organisationId, registrationPlate: plate },
          select: { id: true },
        })
      : null

    const data = {
      organisationId,
      vehicleId:    vehicle?.id ?? null,
      type:         a.type,
      severity,
      message:      a.message,
      relatedId:    a.relatedId ?? null,
      plate,
      acknowledged: a.acknowledged ?? false,
      createdAt,
      source,
      raw:          a as unknown as object,
    }

    const existing = await prisma.providerAlert.findUnique({
      where:  { externalId: a.id },
      select: { id: true },
    })

    if (existing) {
      // A redelivery may carry an updated acknowledged flag. `createdAt` is
      // rewritten too so a re-sync repairs rows stored before the EAT parsing
      // fix. Never re-emit — the feed already has it.
      await prisma.providerAlert.update({
        where: { externalId: a.id },
        data:  { acknowledged: data.acknowledged, createdAt: data.createdAt },
      })
      result.updated++
      continue
    }

    const row = await prisma.providerAlert.create({ data: { ...data, externalId: a.id } })
    result.created++

    if (emit) publishToFeed(organisationId, row)
  }

  return result
}

/**
 * Seed the live feed from alerts already in the database.
 *
 * The feed buffer is in-memory, so a restart empties it and the panel goes
 * blank even though hundreds of real alerts are stored. This replays the most
 * recent ones (oldest → newest, so clients that prepend end up newest-first)
 * into the buffer at startup. Nothing is broadcast to a client that already
 * has them: replayDashboardFeed serves the buffer on connect.
 *
 * Called once at boot — see src/index.ts.
 */
export async function seedFeedFromStoredAlerts(limit = 40): Promise<number> {
  const rows = await prisma.providerAlert.findMany({
    orderBy: { createdAt: 'desc' },
    take:    limit,
    select:  {
      id: true, organisationId: true, type: true, severity: true,
      message: true, plate: true, vehicleId: true, createdAt: true,
    },
  })
  // Oldest first so the buffer's order matches live arrival order. No banner:
  // these are history being restored, not incidents happening now.
  for (const row of rows.reverse()) publishToFeed(row.organisationId, row, { banner: false })
  logger.info({ seeded: rows.length }, 'Live feed seeded from stored provider alerts')
  return rows.length
}

interface FeedRow {
  id:        string
  type:      string
  severity:  string
  message:   string
  plate:     string | null
  vehicleId: string | null
  createdAt: Date
}

// The Live Feed panel renders { time, type, text }; `ts`/`plate`/`alertType`
// ride along for clients that want to deep-link or filter.
const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

function publishToFeed(orgId: string, row: FeedRow, { banner = true } = {}): void {
  const ms = row.createdAt.getTime()
  emitDashboardFeed(orgId, {
    id:        `pa-${row.id}`,
    time:      clockFmt.format(ms),
    ts:        row.createdAt.toISOString(),
    type:      row.severity,          // info | warning | critical
    text:      row.message,           // the provider's own wording
    source:    'controltech',
    alertType: row.type,
    plate:     row.plate,
    vehicleId: row.vehicleId,
  })

  // Critical alerts also raise a banner/toast on the dashboard.
  if (banner && row.severity === 'critical') {
    emitDashboardAlert(orgId, {
      alertType:   row.type,
      severity:    'CRITICAL',
      title:       row.message,
      plate:       row.plate,
      vehicleId:   row.vehicleId,
      triggeredAt: row.createdAt.toISOString(),
      source:      'controltech',
    })
  }
}
