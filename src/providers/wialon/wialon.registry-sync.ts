/**
 * Wialon unit registry sync: one fleet's Wialon units → its `vehicles` rows.
 *
 * The body of `prisma/sync-wialon.ts`, moved here so the same code runs both by
 * hand (the CLI, dry run by default) and on a schedule inside the server
 * (lib/queues/wialon-registry.ts). One run, idempotent:
 *
 *   · a unit new in Wialon gets a vehicle row (`external_id = wialon:<unitId>`)
 *     and its last known position as one telemetry ping;
 *   · a unit renamed, regrouped, retyped or given a tank size is updated, and
 *     only when something actually changed, so a quiet cycle writes nothing;
 *   · a unit gone from Wialon is deactivated: it keeps its history and leaves
 *     the live fleet. Nothing is ever hard-deleted.
 *
 * What a sync never does to a stored value: replace a vehicle type with
 * UNSPECIFIED (operators set types Wialon does not carry, e.g. the West Kenya
 * SALOONs on 2026-11-04), or blank a tank capacity because the sensor name
 * stopped stating it.
 *
 * Refuses outright, before writing anything, when the unit list has halved or
 * doubled against what the org holds: that is an account move or a token that
 * lost a right, not a fleet change, and an unattended run must not act on it.
 */

import type { PrismaClient } from '../../../generated/prisma/client.js'
import { positionToTelemetry, type WialonClient, type WialonUnit } from './wialon.client.js'
import { tankCapacityOf } from './wialon.sensors.js'
import { classifyUnit } from './wialon.vehicle-type.js'
import type { WialonFleet } from './wialon.account.js'
import { normalisePlate } from './wialon.unit-name.js'

/** The halved-or-doubled guard tripped. Nothing was written. */
export class RegistrySyncRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistrySyncRefused'
  }
}

/**
 * Units read once per cycle and shared by every fleet in it. Four fleets live
 * in Rai Group's account, so without this one cycle would download that
 * account's ~900 units four times.
 */
export class WialonUnitSource {
  private byAccount = new Map<number, Promise<WialonUnit[]>>()
  private everything: Promise<WialonUnit[]> | null = null
  constructor(private readonly client: WialonClient) {}
  account(accountId: number): Promise<WialonUnit[]> {
    let p = this.byAccount.get(accountId)
    if (!p) { p = this.client.listUnits(accountId); this.byAccount.set(accountId, p) }
    return p
  }
  all(): Promise<WialonUnit[]> {
    return (this.everything ??= this.client.listUnits())
  }
}

export interface RegistrySyncOptions {
  apply: boolean
  /**
   * Which units get their last known position written as a ping. 'all' is the
   * CLI's behaviour; 'created' is the scheduled job's, since the live poller
   * already writes positions for every unit it knows about.
   */
  positions: 'all' | 'created'
}

export interface RegistrySyncReport {
  orgCode:      string
  accountId:    number
  units:        number
  /** Units in the account before the name mask, when there is one. */
  inAccount:    number
  groups:       Array<{ code: string; name: string; count: number }>
  /** A second tracker on one vehicle: the plate went to the shorter-named unit. */
  twoDevice:    Array<{ name: string; plate: string; wanted: string }>
  /** No plate and a name shared with another unit: qualified with the unit id. */
  sameName:     Array<{ name: string; plate: string }>
  /** Plates already held by another organisation's vehicle. */
  crossOrg:     Array<{ plate: string; code: string; name: string; blocked: boolean }>
  /** Plates passing from a unit that left Wialon to its replacement. */
  handOvers:    Array<{ plate: string; externalId: string; name: string }>
  toCreate:     Array<{ plate: string; type: string; name: string }>
  /** Existing rows whose stored values differ from Wialon's. */
  toUpdate:     Array<{ plate: string; name: string; fields: string[] }>
  unchanged:    number
  /** Active rows whose unit is gone from Wialon. */
  toDeactivate: Array<{ plate: string; name: string; externalId: string }>
  skipped:      number
  withTank:     number
  withPos:      number
  applied: null | {
    created: number; updated: number; failed: number
    deactivated: number; pings: number; stale: number
    failures: Array<{ name: string; externalId: string; error: string }>
  }
}

/**
 * One physical vehicle can carry two trackers, and then two units name one
 * plate (Menengai: "… - KCC 386Z" beside "… - KCC 386Z - FMB140"). The plate
 * column is globally unique, so the SHORTER name keeps it and the other is
 * labelled with its full unit name. Where names are not unique either (32 West
 * Sugar units share four names), the value is qualified with the unit id.
 */
function resolvePlates(units: WialonUnit[], plateOf: (nm: string) => string): Map<number, string> {
  const claims = new Map<string, WialonUnit[]>()
  for (const u of units) {
    const p = plateOf(u.nm)
    claims.set(p, [...(claims.get(p) ?? []), u])
  }
  const out   = new Map<number, string>()
  const taken = new Set<string>()
  const claim = (u: WialonUnit, preferred: string): void => {
    const value = taken.has(preferred) ? `${u.nm.trim()} · wialon:${u.id}` : preferred
    taken.add(value)
    out.set(u.id, value)
  }
  for (const [plate, claimants] of claims) {
    const ranked = [...claimants].sort((a, b) => a.nm.trim().length - b.nm.trim().length || a.id - b.id)
    ranked.forEach((u, i) => claim(u, i === 0 ? plate : u.nm.trim()))
  }
  return out
}

const errorText = (err: unknown): string =>
  err instanceof Error ? (err.message.split('\n').at(-1) ?? err.message) : String(err)

export async function syncWialonFleet(
  prisma: PrismaClient,
  source: WialonUnitSource,
  fleet: WialonFleet,
  opts: RegistrySyncOptions,
): Promise<RegistrySyncReport> {
  const org = await prisma.organisation.findUnique({ where: { code: fleet.orgCode }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${fleet.orgCode} not found — run: npm run seed:org -- --code=${fleet.orgCode}`)

  // ONLY this fleet's own units: the token sees eight customers' fleets.
  const owned     = await source.account(fleet.accountId)
  const inAccount = fleet.nameMask ? owned.filter(u => fleet.nameMask!.test(u.nm)) : owned
  // Billed to another account; without these the sweep would deactivate them.
  const extras = fleet.extraUnitIds?.length
    ? (await source.all()).filter(u => fleet.extraUnitIds!.includes(u.id) && !inAccount.some(x => x.id === u.id))
    : []
  const units = [...inAccount, ...extras]
  if (units.length === 0) {
    throw new RegistrySyncRefused(
      fleet.nameMask
        ? `No unit in account ${fleet.accountId} matches ${fleet.nameMask} — refusing to continue on what looks like a renamed fleet`
        : 'Wialon returned no units — refusing to deactivate the whole fleet on a bad response',
    )
  }

  // A registry sync refreshes a fleet, never replaces one.
  const known = await prisma.vehicle.count({ where: { organisationId: org.id, isActive: true } })
  if (known > 0 && (units.length < known / 2 || units.length > known * 2)) {
    throw new RegistrySyncRefused(
      `Wialon returned ${units.length} units for account ${fleet.accountId}, but ${fleet.orgCode} ` +
      `holds ${known} active vehicles. Too large a change to apply unattended — check the account id ` +
      `and the token's access, then run sync-wialon by hand.`,
    )
  }

  // ── plates ────────────────────────────────────────────────────────────────
  const plateFor  = resolvePlates(units, fleet.plateOf)
  const displaced = units.filter(u => plateFor.get(u.id) !== fleet.plateOf(u.nm))
  const twoDevice = displaced.filter(u => fleet.plateOf(u.nm) !== u.nm.trim())
    .map(u => ({ name: u.nm, plate: plateFor.get(u.id)!, wanted: fleet.plateOf(u.nm) }))
  const sameName  = displaced.filter(u => fleet.plateOf(u.nm) === u.nm.trim())
    .map(u => ({ name: u.nm, plate: plateFor.get(u.id)! }))

  // `registration_plate` is unique across the WHOLE table. A byte-identical
  // string held by another org would fail the insert, so it is skipped; the
  // same machine spelled differently inserts and is only reported.
  const wanted = [...plateFor.values()]
  const sameMachine = await prisma.$queryRawUnsafe<Array<{ plate: string; code: string; name: string }>>(
    `select v.registration_plate as plate, o.code, v.name
       from vehicles v join organisations o on o.id = v.organisation_id
      where o.id <> $1
        and upper(regexp_replace(v.registration_plate, '[^A-Za-z0-9]', '', 'g')) = any($2::text[])
        -- the same unit's own row under another org is a MOVE (Kabras out of
        -- West Sugar, 2026-10-07): the upsert by external id re-homes it.
        and (v.external_id is null or v.external_id <> all($3::text[]))`,
    org.id, wanted.map(normalisePlate), units.map(u => `wialon:${u.id}`),
  )
  const exact   = new Set(wanted)
  const blocked = new Set(sameMachine.filter(r => exact.has(r.plate)).map(r => r.plate))
  const crossOrg = sameMachine.map(r => ({ ...r, blocked: blocked.has(r.plate) }))

  // ── groups ────────────────────────────────────────────────────────────────
  const groups = new Map<string, { name: string; count: number }>()
  for (const u of units) {
    const g = fleet.groupOf(u.nm)
    groups.set(g.code, { name: g.name, count: (groups.get(g.code)?.count ?? 0) + 1 })
  }
  const groupRows = await prisma.vehicleGroup.findMany({
    where:  { organisationId: org.id, code: { in: [...groups.keys()] } },
    select: { id: true, code: true },
  })
  const groupId = new Map(groupRows.map(g => [g.code, g.id]))

  // ── what Wialon says each unit should be ──────────────────────────────────
  const tankOf = (u: WialonUnit) => (fleet.tankOf ? fleet.tankOf(u.sens) : tankCapacityOf(u.sens))
  const desired = (u: WialonUnit) => ({
    vehicleGroupCode:   fleet.groupOf(u.nm).code,
    name:               u.nm.trim(),
    registrationPlate:  plateFor.get(u.id)!,
    // Wialon has no body-type field; read from the declared TYPE or the code
    // in the name, or the fleet's own rule (wialon.account).
    vehicleType:        fleet.typeOf?.(u.nm, u.sens) ?? classifyUnit(u.nm, u.flds),
    status:             u.pos ? 'TRACKING' : 'NO_SIGNAL',
    // Written into the fuel sensor's NAME by the operator, e.g. "(450L)".
    tankCapacityLitres: tankOf(u),
  })

  const existingRows = await prisma.vehicle.findMany({
    where:  { externalId: { in: units.map(u => `wialon:${u.id}`) } },
    select: {
      id: true, externalId: true, organisationId: true, vehicleGroupId: true, name: true,
      registrationPlate: true, vehicleType: true, status: true, isActive: true, tankCapacityLitres: true,
    },
  })
  const existing = new Map(existingRows.map(r => [r.externalId!, r]))

  type Change = { unit: WialonUnit; fields: string[]; data: Record<string, unknown> }
  const changes: Change[] = []
  let unchanged = 0
  for (const u of units) {
    const row = existing.get(`wialon:${u.id}`)
    if (!row) continue
    const d = desired(u)
    if (blocked.has(d.registrationPlate)) continue
    const gid = groupId.get(d.vehicleGroupCode) ?? null
    const data: Record<string, unknown> = {}
    if (row.organisationId !== org.id)                          data.organisationId = org.id
    if (gid === null || row.vehicleGroupId !== gid)             data.vehicleGroupCode = d.vehicleGroupCode
    if (row.name !== d.name)                                    data.name = d.name
    if (row.registrationPlate !== d.registrationPlate)          data.registrationPlate = d.registrationPlate
    if (d.vehicleType !== 'UNSPECIFIED' && row.vehicleType !== d.vehicleType) data.vehicleType = d.vehicleType
    if (row.status !== d.status)                                data.status = d.status
    if (!row.isActive)                                          data.isActive = true
    if (d.tankCapacityLitres != null && row.tankCapacityLitres !== d.tankCapacityLitres) {
      data.tankCapacityLitres = d.tankCapacityLitres
    }
    const fields = Object.keys(data).map(k => (k === 'vehicleGroupCode' ? 'group' : k))
    if (fields.length === 0) { unchanged++; continue }
    changes.push({ unit: u, fields, data })
  }

  const toCreateUnits = units.filter(u => !existing.has(`wialon:${u.id}`) && !blocked.has(plateFor.get(u.id)!))

  // ── plate hand-overs (a tracker swap: the replacement unit takes the plate)
  const unitIds = new Set(units.map(u => `wialon:${u.id}`))
  const holders = await prisma.vehicle.findMany({
    where:  { organisationId: org.id, externalId: { startsWith: 'wialon:' }, registrationPlate: { in: wanted } },
    select: { id: true, externalId: true, name: true, registrationPlate: true },
  })
  const handOvers = holders.filter(h => !unitIds.has(h.externalId!))

  const goneRows = await prisma.vehicle.findMany({
    where:  { organisationId: org.id, isActive: true, externalId: { startsWith: 'wialon:', notIn: [...unitIds] } },
    select: { externalId: true, name: true, registrationPlate: true },
  })

  const report: RegistrySyncReport = {
    orgCode:   fleet.orgCode,
    accountId: fleet.accountId,
    units:     units.length,
    inAccount: owned.length,
    groups:    [...groups].map(([code, g]) => ({ code, ...g })).sort((a, b) => b.count - a.count),
    twoDevice,
    sameName,
    crossOrg,
    handOvers: handOvers.map(h => ({ plate: h.registrationPlate, externalId: h.externalId!, name: h.name })),
    toCreate:  toCreateUnits.map(u => ({ plate: plateFor.get(u.id)!, type: desired(u).vehicleType, name: u.nm })),
    toUpdate:  changes.map(c => ({ plate: plateFor.get(c.unit.id)!, name: c.unit.nm, fields: c.fields })),
    unchanged,
    toDeactivate: goneRows.map(r => ({ plate: r.registrationPlate, name: r.name, externalId: r.externalId! })),
    skipped:   blocked.size,
    withTank:  units.filter(u => tankOf(u) != null).length,
    withPos:   units.filter(u => u.pos).length,
    applied:   null,
  }
  if (!opts.apply) return report

  // ── apply ─────────────────────────────────────────────────────────────────
  // Released first: the replacement unit's update would otherwise hit the
  // unique plate still held by the row it replaces.
  for (const h of handOvers) {
    await prisma.vehicle.update({
      where: { id: h.id },
      data:  { isActive: false, registrationPlate: `${h.name} · ${h.externalId}` },
    })
  }

  for (const [code, g] of groups) {
    if (groupId.has(code)) continue
    const row = await prisma.vehicleGroup.upsert({
      where:  { organisationId_code: { organisationId: org.id, code } },
      update: {},
      create: { organisationId: org.id, name: g.name, code },
      select: { id: true },
    })
    groupId.set(code, row.id)
  }

  const applied: NonNullable<RegistrySyncReport['applied']> = {
    created: 0, updated: 0, failed: 0, deactivated: 0, pings: 0, stale: 0, failures: [],
  }
  const now = Date.now()

  const writePosition = async (vehicleId: string, externalId: string, u: WialonUnit): Promise<void> => {
    if (!u.pos) return
    const t = positionToTelemetry(u.pos)
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) return
    if (now - t.capturedAt.getTime() > 30 * 86_400_000) applied.stale++
    const already = await prisma.vehicleTelemetry.findFirst({
      where: { vehicleId, capturedAt: t.capturedAt }, select: { id: true },
    })
    if (already) return
    const row = await prisma.vehicleTelemetry.create({
      data: {
        vehicleId,
        deviceId:   externalId,
        capturedAt: t.capturedAt,
        receivedAt: new Date(),
        lat:        t.lat,
        lng:        t.lng,
        altitudeM:  t.altitudeM,
        speedKmh:   t.speedKmh,
        headingDeg: t.headingDeg,
        engineOn:   t.engineOn,
        // Fuel, cargo and odometer are not in `pos`: left NULL, not guessed.
      },
      select: { id: true },
    })
    await prisma.vehicleTelemetryRaw.create({
      data: { telemetryId: row.id, payload: { source: 'wialon', unitId: u.id, pos: u.pos } as object },
    })
    applied.pings++
  }

  for (const u of toCreateUnits) {
    const externalId = `wialon:${u.id}`
    const d = desired(u)
    try {
      const v = await prisma.vehicle.create({
        data: {
          organisationId:     org.id,
          vehicleGroupId:     groupId.get(d.vehicleGroupCode)!,
          name:               d.name,
          registrationPlate:  d.registrationPlate,
          vehicleType:        d.vehicleType,
          status:             d.status,
          isActive:           true,
          tankCapacityLitres: d.tankCapacityLitres,
          externalId,
          deviceId:           externalId,
        },
        select: { id: true },
      })
      applied.created++
      await writePosition(v.id, externalId, u)
    } catch (err) {
      applied.failed++
      applied.failures.push({ name: u.nm, externalId, error: errorText(err) })
    }
  }

  for (const c of changes) {
    const externalId = `wialon:${c.unit.id}`
    const { vehicleGroupCode, ...rest } = c.data
    const data = vehicleGroupCode ? { ...rest, vehicleGroupId: groupId.get(vehicleGroupCode as string)! } : rest
    try {
      const row = await prisma.vehicle.update({ where: { externalId }, data, select: { id: true } })
      applied.updated++
      if (opts.positions === 'all') await writePosition(row.id, externalId, c.unit)
    } catch (err) {
      applied.failed++
      applied.failures.push({ name: c.unit.nm, externalId, error: errorText(err) })
    }
  }

  // The CLI has always pinged every unit; unchanged rows included.
  if (opts.positions === 'all') {
    const changed = new Set(changes.map(c => c.unit.id))
    for (const u of units) {
      if (changed.has(u.id)) continue
      const row = existing.get(`wialon:${u.id}`)
      if (row) await writePosition(row.id, row.externalId!, u)
    }
  }

  // Units that vanished upstream keep their history but leave the live fleet.
  const gone = await prisma.vehicle.updateMany({
    where: { organisationId: org.id, isActive: true, externalId: { startsWith: 'wialon:', notIn: [...unitIds] } },
    data:  { isActive: false },
  })
  applied.deactivated = gone.count

  report.applied = applied
  return report
}
