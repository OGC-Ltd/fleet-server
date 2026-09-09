/**
 * RaiFactorySuite alert intake — shared by the webhook receiver
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
import { eventBus } from '../../lib/event-bus.js'
import { parseProviderTimeOr } from '../../lib/provider-time.js'
import { resolveOrgId } from './factory-map.js'

/** Alert type → live-feed severity. Unknown types default to `info`. */
const SEVERITY_BY_TYPE: Record<string, 'info' | 'warning' | 'critical'> = {
  TRACTOR_OVERDUE:           'warning',
  DRIVER_BLOCKED:            'critical',
  HOTO_DISCREPANCY:          'warning',
  DRIVER_ASSIGNMENT_CHANGED: 'info',
}

export interface RaiFactorySuiteAlert {
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
  alerts: RaiFactorySuiteAlert[],
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

/* seedFeedFromStoredAlerts lived here. It pre-warmed a single in-memory feed
 * ring shared by every organisation. That ring is gone: each SSE client now
 * replays its OWN org's history from the durable store on connect (see
 * lib/sse.ts's replayDashboardFeed), which survives restarts and cannot be
 * crowded out by a busier organisation. */

interface FeedRow {
  id:        string
  type:      string
  severity:  string
  message:   string
  plate:     string | null
  vehicleId: string | null
  createdAt: Date
}

/**
 * Hand the alert to the event bus rather than to the SSE emitters directly.
 *
 * This used to call emitDashboardFeed/emitDashboardAlert itself, which meant a
 * provider alert reached an OPEN browser tab and nothing else — a
 * DRIVER_BLOCKED critical never produced a Web Push, so anyone with the tab
 * closed never heard about it. notification.worker now owns the fan-out for
 * both alert families (feed, banner, push), and this module's only job is to
 * describe what happened.
 */
function publishToFeed(orgId: string, row: FeedRow, { notify = true } = {}): void {
  eventBus.publish('provider:alert', {
    orgId,
    id:        `pa-${row.id}`,
    source:    'controltech',   // stored value — see provider_alerts.source
    alertType: row.type,
    severity:  row.severity as 'info' | 'warning' | 'critical',
    text:      row.message,     // the provider's own wording
    at:        row.createdAt,
    plate:     row.plate,
    vehicleId: row.vehicleId,
    notify,
  })
}
