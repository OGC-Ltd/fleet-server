/**
 * GET /api/v1/iam/wialon/deactivated-units: the units Wialon (Controltech)
 * has deactivated, per organisation, for the System Administrator to confirm
 * with the people on site (operator, 2026-11-20). Read-only: nothing is
 * stored and nothing is hidden by it.
 *
 * Why it is needed: a deactivated unit vanishes from Wialon's own screens but
 * stays in its unit list, marked deactivated, so the registry sync
 * (wialon.registry-sync), which switches off only units missing from that list,
 * keeps it on our map and in our reports. This lists them first; hiding them
 * is the sync's change, after the list has been checked.
 *
 * Per organisation of the registry sync (wialon.account FLEETS, the same
 * account and name rule as the sync):
 *   - deactivated: units Wialon marks deactivated (`act` 0, else a deactivation
 *     time `dactt`), with the date, the last message, and whether our platform
 *     still shows them;
 *   - removed: units we already switched off because they left the list
 *     (deleted, moved to another account, or renamed out of the fleet).
 * `fieldsSeen`: the top-level fields Wialon sent for the units, names only, so
 * an empty list can be told apart from a field Wialon does not send.
 */
import type { RequestHandler } from 'express'
import { prisma } from '../../lib/prisma.js'
import { env } from '../../config/env.js'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { WialonClient, type WialonUnit } from '../../providers/wialon/wialon.client.js'
import { WialonUnitSource } from '../../providers/wialon/wialon.registry-sync.js'
import { findFleet, syncableOrgCodes, type WialonFleet } from '../../providers/wialon/wialon.account.js'

export interface DeactivatedUnit {
  unitId: number
  name: string
  plate: string | null
  /** When Wialon deactivated it, ISO; null when Wialon gives no date. */
  deactivatedAt: string | null
  /** Its last message to Wialon, ISO; null when it never sent one. */
  lastMessageAt: string | null
  /** Still on our live map and in our reports (until the sync is changed). */
  shownByUs: boolean
}

export interface RemovedUnit { name: string; plate: string; externalId: string }

/**
 * Still on our platform, but not in the unit list Wialon gives us (operator,
 * 2026-11-20: Menengai units Controltech deactivated, gone from Wialon, still
 * shown here). A deactivated unit is usually invisible to our Wialon user, so
 * it does not come back marked deactivated; it is simply not there. `link`:
 * 'wialon' for a unit the sync made from Wialon, 'other' for one made another
 * way, which the sync never switches off.
 */
export interface MissingUnit { name: string; plate: string; link: 'wialon' | 'other'; lastReportedAt: string | null }

export interface CompanyUnits {
  orgCode: string
  orgName: string
  units: number
  deactivated: DeactivatedUnit[]
  removed: RemovedUnit[]
  missing: MissingUnit[]
  error: string | null
}

/**
 * Pure: our active vehicles that are not in Wialon's list for the fleet (its
 * units, plus those billed to another account). Last report added by the caller.
 */
export function missingFromWialon(
  active: ReadonlyArray<{ id: string, name: string, registrationPlate: string, externalId: string | null }>,
  wialonIds: ReadonlySet<number>,
): Array<{ id: string, name: string, plate: string, link: 'wialon' | 'other' }> {
  return active
    .filter((v) => {
      const m = /^wialon:(\d+)$/.exec(v.externalId ?? '')
      return !m || !wialonIds.has(Number(m[1]))
    })
    .map((v) => ({ id: v.id, name: v.name, plate: v.registrationPlate, link: v.externalId?.startsWith('wialon:') ? 'wialon' as const : 'other' as const }))
}

/** Units listed as missing per organisation at most (a last-report lookup each). */
const MISSING_MAX = 300

const iso = (sec: unknown) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null)

/** Pure: whether Wialon marks a unit deactivated, and since when. */
export function wialonActivation(u: Record<string, unknown>): { deactivated: boolean; since: string | null } {
  const act = u['act']
  const since = iso(u['dactt'])
  if (act === 0 || act === false || act === '0') return { deactivated: true, since }
  if (act === 1 || act === true || act === '1') return { deactivated: false, since: null }
  // No activation flag sent: a deactivation time alone says it
  return since ? { deactivated: true, since } : { deactivated: false, since: null }
}

/** Pure: this fleet's units as the sync takes them (its account, then its name rule). */
export function fleetUnits(owned: readonly WialonUnit[], fleet: Pick<WialonFleet, 'nameMask'>): WialonUnit[] {
  return fleet.nameMask ? owned.filter((u) => fleet.nameMask!.test(u.nm)) : [...owned]
}

export const deactivatedUnits: RequestHandler = async (_req, res, next) => {
  try {
    if (!env.WIALON_TOKEN) throw new BadRequestError('This server has no Wialon token.')
    const client = new WialonClient(env.WIALON_TOKEN, env.WIALON_API_URL)
    await client.login()
    const source = new WialonUnitSource(client)
    const fieldsSeen = new Set<string>()
    const companies: CompanyUnits[] = []

    for (const code of syncableOrgCodes()) {
      const fleet = findFleet(code)!
      const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true, name: true } })
      if (!org) continue
      const out: CompanyUnits = { orgCode: code, orgName: org.name, units: 0, deactivated: [], removed: [], missing: [], error: null }
      try {
        const units = fleetUnits(await source.account(fleet.accountId), fleet)
        out.units = units.length
        const ours = await prisma.vehicle.findMany({
          where: { organisationId: org.id, externalId: { startsWith: 'wialon:' } },
          select: { externalId: true, registrationPlate: true, name: true, isActive: true },
        })
        const byExt = new Map(ours.map((v) => [v.externalId, v]))
        for (const u of units) {
          for (const k of Object.keys(u)) fieldsSeen.add(k)
          const a = wialonActivation(u as unknown as Record<string, unknown>)
          if (!a.deactivated) continue
          const v = byExt.get(`wialon:${u.id}`)
          out.deactivated.push({
            unitId: u.id, name: u.nm.trim(), plate: v?.registrationPlate ?? null,
            deactivatedAt: a.since, lastMessageAt: iso(u.lmsg?.t ?? u.pos?.t),
            shownByUs: Boolean(v?.isActive),
          })
        }
        const inList = new Set(units.map((u) => `wialon:${u.id}`))
        out.removed = ours.filter((v) => !v.isActive && v.externalId && !inList.has(v.externalId))
          .map((v) => ({ name: v.name, plate: v.registrationPlate, externalId: v.externalId! }))
        // On our platform, not in Wialon's list (any link), and when each last reported
        const wialonIds = new Set([...units.map((u) => u.id), ...(fleet.extraUnitIds ?? [])])
        const active = await prisma.vehicle.findMany({
          where: { organisationId: org.id, isActive: true },
          select: { id: true, name: true, registrationPlate: true, externalId: true },
        })
        const gone = missingFromWialon(active, wialonIds).slice(0, MISSING_MAX)
        out.missing = await Promise.all(gone.map(async (v) => {
          const last = await prisma.vehicleTelemetry.findFirst({
            where: { vehicleId: v.id }, orderBy: { capturedAt: 'desc' }, select: { capturedAt: true },
          })
          return { name: v.name, plate: v.plate, link: v.link, lastReportedAt: last?.capturedAt.toISOString() ?? null }
        }))
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err)
      }
      out.deactivated.sort((x, y) => (y.deactivatedAt ?? '').localeCompare(x.deactivatedAt ?? '') || x.name.localeCompare(y.name))
      out.removed.sort((x, y) => x.name.localeCompare(y.name))
      out.missing.sort((x, y) => (x.lastReportedAt ?? '').localeCompare(y.lastReportedAt ?? '') || x.name.localeCompare(y.name))
      companies.push(out)
    }

    sendSuccess(res, { checkedAt: new Date().toISOString(), fieldsSeen: [...fieldsSeen].sort(), companies })
  } catch (err) { next(err) }
}
