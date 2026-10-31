// The end-of-shift report for one organisation (operator, 2026-10-31): the
// fleet day, midnight to 23:59 Nairobi, up to the moment it is made while the
// day is still running (operator, 2026-11-01), what the control room hands
// over. Fuel at
// the top, theft as the one critical section, policy breaches as counts with
// the top five units for each kind, every unit still outside a geofence with
// when it left, then the weighbridge and the products ferried.
//
// Pure: the shift's records come in (end-of-shift.data gathers them), the
// report's sections come out. end-of-shift.pdf lays them out. Moved here from
// the dashboard (raitrack lib/endOfShiftReport), which used to build it in the
// browser from eight separate reads.

const H = 3_600_000
/** Out longer than this, or with no dispatch, is marked red. */
export const LONG_OUT_MS = 12 * H
export const TOP = 5

type When = string | number | Date | null | undefined

const plateKey = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const ms = (v: When): number =>
  v == null ? NaN : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v)
const round1 = (n: number) => Math.round(n * 10) / 10
const eatHour = (t: number) => new Date(t + 3 * H).getUTCHours()

/**
 * Midnight Nairobi of the day `now` falls on. The report covers that day,
 * 00:00 to 23:59, and stops at `now` while the day is still running.
 *
 * It used to be 06:00, with the shift running on into the next morning, so a
 * report made at 01:24 read "31/10, 06:00 to 01:24" (operator, 2026-11-01).
 */
export function shiftStart(now = Date.now()): number {
  const day = new Date(now + 3 * H).toISOString().slice(0, 10)
  return Date.parse(`${day}T00:00:00+03:00`)
}

/** 23:59:59.999 Nairobi of the day `now` falls on. */
export function shiftEnd(now = Date.now()): number {
  return shiftStart(now) + 24 * H - 1
}

// ── inputs ────────────────────────────────────────────────────────────────────

/** One unit of the fleet as the snapshot has it now (see end-of-shift.data). */
export interface ShiftUnit {
  vehicleId: string
  /** The plate where the unit has one, else its name or id. */
  plate: string
  driver: string | null
  zones: { known?: boolean; inside?: Array<{ area?: boolean | null }> } | null
  /** The open dispatch's tag, when the unit is out on one. */
  dispatch: string | null
  lat: number | null
  lng: number | null
  /** The newest fix, ms. */
  seenAt: number | null
}

export interface ShiftFilling { vehicleId: string; filledAt: When; filledMl: number | null; location?: string | null; verdict?: string | null }
export interface ShiftTheft {
  vehicleId: string; beganAt?: When; detectedAt?: When; stolenMl?: number | null; cleanDropMl?: number | null
  initialLocation?: string | null; verdict?: string | null; reviewStatus?: string | null; initialSpeedKmh?: number | null
}
export interface ShiftSpeeding {
  vehicleId: string; plate?: string | null; incidents?: number | null; peakKmh?: number | null; limitKmh?: number | null
  driverName?: string | null; totalSeconds?: number | null; avgOverKmh?: number | null
}
/** A feed item (notifications): harsh driving, zone crossings, sales dispatches. */
export interface ShiftFeedItem { id: string; ts?: string; time?: string; alertType?: string | null; vehicleId?: string | null; plate?: string | null; text?: string }
export interface ShiftAlarm { code: number; label?: string | null; occurredAt?: When; vehicleId?: string | null; plate?: string | null }
export interface ShiftTicket {
  id?: string | null; token?: string | null; centerCode?: number | null; centerName?: string | null
  vehicleId?: string | null; vehiclePlate?: string | null; vehicleNo?: string | null; driverName?: string | null
  netWeightKg?: number | null; factoryNetWeightKg?: number | null; grossAt?: When; tokenAt?: When; productName?: string | null
}

export interface ShiftInput {
  from: number
  to: number
  units?: ShiftUnit[]
  fillings?: ShiftFilling[]
  thefts?: ShiftTheft[]
  speeding?: ShiftSpeeding[]
  harsh?: ShiftFeedItem[]
  /** Null for a fleet without dashcams. */
  alarms?: ShiftAlarm[] | null
  /** ZONE_EXIT and ZONE_ENTRY over the shift, any order. */
  zones?: ShiftFeedItem[]
  /** Null for a fleet without weighbridges. */
  tickets?: ShiftTicket[] | null
  sales?: ShiftFeedItem[]
  /** vehicleId → place name, for "Now near". */
  places?: Map<string, string>
}

// ── vocabulary ────────────────────────────────────────────────────────────────

/** Dashcam alarm codes (dashcam/vss-events). */
const PHONE = new Set([116, 264])
const SEATBELT = new Set([125, 51])
const COVERED = new Set([123, 3])
export type AlarmKind = 'phone' | 'seatbelt' | 'covered'
export function alarmKind(a: { code?: number | null; label?: string | null } | null | undefined): AlarmKind | null {
  const code = a?.code ?? NaN
  if (PHONE.has(code)) return 'phone'
  if (SEATBELT.has(code)) return 'seatbelt'
  if (COVERED.has(code)) return 'covered'
  const s = String(a?.label ?? '').toLowerCase()
  if (/phone|texting/.test(s)) return 'phone'
  if (/seat\s*belt/.test(s)) return 'seatbelt'
  if (/camera covered|video cover|lens cover/.test(s)) return 'covered'
  return null
}

export type BreachKey = 'speed' | 'phone' | 'seatbelt' | 'brake' | 'accel' | 'covered'
export const BREACHES: Array<{ key: BreachKey; label: string }> = [
  { key: 'speed', label: 'Overspeeding' },
  { key: 'phone', label: 'On phone' },
  { key: 'seatbelt', label: 'No seatbelt' },
  { key: 'brake', label: 'Harsh braking' },
  { key: 'accel', label: 'Harsh acceleration' },
  { key: 'covered', label: 'Camera covered' },
]
const FROM_DASHCAM = new Set<BreachKey>(['phone', 'seatbelt', 'covered'])

const NOT_REAL = new Set(['REDISTRIBUTION', 'SENSOR_FAULT'])
const DRAIN_STATUS: Record<string, string> = {
  DRAIN: 'Theft, not yet reviewed', PENDING: 'Being checked', REFILL: 'Was a refill',
  REDISTRIBUTION: 'Probe swing, came back', SENSOR_FAULT: 'Probe fault',
}
/** c = critical, o = open, m = muted. */
export type Tone = 'c' | 'o' | 'm'
const REVIEW: Record<string, [string, Tone]> = {
  CONFIRMED_THEFT: ['Confirmed theft', 'c'], UNDER_REVIEW: ['Escalated', 'c'],
  NOT_THEFT: ['De-escalated', 'm'], PROBE_FAULT: ['Probe fault', 'm'], DISMISSED: ['Dismissed', 'm'],
}

/** Commodity by the factory a sales run signs out at (webhooks/factory-map). */
const FACTORY_PRODUCT: Record<string, string> = { NAITIRI: 'Processed sugar', NDHIWA: 'Raw sugarcane' }

/** "KDL 715E · Jane signed out at Naitiri with 29.0t (580 × 50 kg bags) bound for Raiply and left the premises." */
export function parseSale(text: unknown) {
  const s = String(text ?? '')
  const t = /with ([\d.]+)\s*t\b/i.exec(s)
  const bags = /\(([\d,]+)\s*×/.exec(s)
  const at = /signed out at (.+?)(?= with | bound for | and left|$)/i.exec(s)?.[1]?.trim() ?? null
  const destination = /bound for (.+?)(?= and left|\.$|$)/i.exec(s)?.[1]?.trim() ?? null
  return {
    tonnes: t ? Number(t[1]) : null,
    bags: bags ? Number(bags[1]!.replace(/,/g, '')) : null,
    at, destination,
    product: FACTORY_PRODUCT[String(at ?? '').toUpperCase()] ?? 'Sales load',
  }
}

/** "KDL 715E left NAITIRI YARD." → "NAITIRI YARD"; an exit into another zone is not a way out. */
export function exitZone(text: unknown): string | null {
  const s = String(text ?? '')
  if (/ is now in /i.test(s)) return null
  return /\bleft (.+?)(?: and .+)?\.?$/i.exec(s)?.[1]?.trim() ?? null
}

const titleName = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
function mostCommon(xs: Array<string | null | undefined>): string | null {
  const m = new Map<string, number>()
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * A weighbridge row as one load, or null when it has no usable weight: the
 * mill's net when the load reached the mill, otherwise the outstation's. (The
 * dashboard's Drivers page counts a load the same way.)
 */
function ticketLoad(w: ShiftTicket) {
  const factory = Number(w.factoryNetWeightKg)
  const centre = Number(w.netWeightKg)
  const kg = factory > 0 ? factory : centre > 0 ? centre : null
  const at = Number.isFinite(ms(w.grossAt)) ? ms(w.grossAt) : ms(w.tokenAt)
  if (kg == null || kg > 80_000 || !Number.isFinite(at)) return null
  return { id: String(w.id ?? `${w.centerCode}-${w.token}`), at, vehicleId: w.vehicleId ?? null, kg, where: w.centerName ?? null, toMill: factory > 0 }
}

// ── the report ────────────────────────────────────────────────────────────────

export interface BreachRow { plate: string; driver: string | null; times: number; peak?: number; limit?: number; avgOver?: number; cases?: number; overSec?: number }

export function buildEndOfShift({
  from, to, units = [], fillings = [], thefts = [], speeding = [], harsh = [], alarms = null,
  zones = [], tickets = null, sales = [], places = new Map(),
}: ShiftInput) {
  const inShift = (t: number) => Number.isFinite(t) && t >= from && t <= to
  const byId = new Map(units.map((v) => [v.vehicleId, v]))
  const byPlate = new Map(units.map((v) => [plateKey(v.plate), v]))
  const unitOf = (vehicleId?: string | null, plate?: string | null) =>
    (vehicleId ? byId.get(vehicleId) : undefined) ?? byPlate.get(plateKey(plate)) ?? null
  const plateOf = (vehicleId?: string | null, plate?: string | null) => unitOf(vehicleId, plate)?.plate ?? (plate || '?')
  const driverOf = (vehicleId?: string | null, plate?: string | null) => unitOf(vehicleId, plate)?.driver ?? null
  const driverOfPlate = (p: string) => byPlate.get(plateKey(p))?.driver ?? null

  // ── fuel ──
  const refills = fillings
    .map((f) => ({ t: ms(f.filledAt), plate: plateOf(f.vehicleId), litres: f.filledMl != null ? round1(f.filledMl / 1000) : 0, place: f.location ?? null, real: !NOT_REAL.has(f.verdict ?? '') }))
    .filter((f) => inShift(f.t) && f.real)
  const drains = thefts.map((d) => {
    const ml = d.cleanDropMl ?? d.stolenMl
    const review = REVIEW[d.reviewStatus ?? ''] ?? null
    const verdict = d.verdict ?? 'PENDING'
    const tone: Tone = review?.[1] ?? (verdict === 'DRAIN' ? 'c' : verdict === 'PENDING' ? 'o' : 'm')
    return {
      t: ms(d.beganAt ?? d.detectedAt), plate: plateOf(d.vehicleId), driver: driverOf(d.vehicleId),
      litres: ml != null ? round1(ml / 1000) : 0, place: d.initialLocation ?? null,
      verdict, stationary: d.initialSpeedKmh === 0,
      status: review?.[0] ?? DRAIN_STATUS[verdict] ?? verdict, tone,
      escalated: d.reviewStatus === 'CONFIRMED_THEFT' || d.reviewStatus === 'UNDER_REVIEW',
    }
  }).filter((d) => inShift(d.t)).sort((a, b) => a.t - b.t)
  const sumL = (xs: Array<{ litres: number }>) => round1(xs.reduce((n, x) => n + (x.litres || 0), 0))

  // ── policy breaches ──
  const per = Object.fromEntries(BREACHES.map((b) => [b.key, new Map<string, BreachRow>()])) as Record<BreachKey, Map<string, BreachRow>>
  const bump = (kind: BreachKey, vehicleId: string | null | undefined, plate: string | null | undefined,
    extra: { times?: number; peak?: number | null; limit?: number | null; overSec?: number | null; avgOver?: number | null; driver?: string | null } = {}) => {
    const p = plateOf(vehicleId, plate)
    const m = per[kind]
    const r = m.get(p) ?? { plate: p, driver: driverOf(vehicleId, plate), times: 0 }
    r.times += extra.times ?? 1
    if (extra.peak != null) { r.peak = Math.max(r.peak ?? 0, extra.peak); r.limit = extra.limit ?? r.limit }
    if (extra.overSec != null) {
      // Average over the limit, weighted by cases, across the unit's rows.
      const n0 = r.cases ?? 0, n1 = extra.times ?? 1
      if (extra.avgOver != null) r.avgOver = ((r.avgOver ?? 0) * n0 + extra.avgOver * n1) / (n0 + n1)
      r.cases = n0 + n1
      r.overSec = (r.overSec ?? 0) + extra.overSec
    }
    if (!r.driver && extra.driver) r.driver = extra.driver
    m.set(p, r)
  }
  for (const s of speeding) {
    bump('speed', s.vehicleId, s.plate, { times: s.incidents ?? 1, peak: s.peakKmh, limit: s.limitKmh, driver: s.driverName,
      overSec: s.totalSeconds ?? 0, avgOver: s.avgOverKmh ?? null })
  }
  const seen = new Set<string>()
  for (const h of harsh) {
    const t = ms(h.ts ?? h.time)
    if (!inShift(t) || seen.has(h.id)) continue
    seen.add(h.id)
    if (h.alertType === 'HARSH_BRAKING') bump('brake', h.vehicleId, h.plate)
    else if (h.alertType === 'HARSH_ACCELERATION') bump('accel', h.vehicleId, h.plate)
  }
  for (const a of alarms ?? []) {
    const k = alarmKind(a)
    if (k && inShift(ms(a.occurredAt))) bump(k, a.vehicleId, a.plate)
  }
  const breaches = BREACHES.map((b) => {
    // Overspeeding ranks by time spent over the limit; the rest by how often.
    const rank = b.key === 'speed'
      ? (x: BreachRow, y: BreachRow) => (y.overSec ?? 0) - (x.overSec ?? 0) || (y.peak ?? 0) - (x.peak ?? 0)
      : (x: BreachRow, y: BreachRow) => y.times - x.times
    const rows = [...per[b.key].values()].sort((x, y) => rank(x, y) || x.plate.localeCompare(y.plate))
    return { ...b, total: rows.reduce((n, r) => n + r.times, 0), units: rows.length, top: rows.slice(0, TOP), fromDashcam: FROM_DASHCAM.has(b.key) }
  })

  // ── out of geofence during the shift ──
  // Only what happened in the shift (operator, 2026-10-31): a unit that left a
  // geofence after midnight and is still outside is listed; one that left and
  // came back is counted, with how long it was out. A unit already outside at
  // midnight is neither.
  const zoneEvents = zones
    .map((e) => ({ t: ms(e.ts ?? e.time), v: unitOf(e.vehicleId, e.plate), exit: e.alertType === 'ZONE_EXIT', text: e.text }))
    .filter((e): e is typeof e & { v: ShiftUnit } => e.v != null && inShift(e.t))
    .sort((a, b) => a.t - b.t)
  const open = new Map<string, { at: number; zone: string }>()
  const trips: Array<{ plate: string; out: number; back: number; ms: number; zone: string }> = []
  for (const e of zoneEvents) {
    const id = e.v.vehicleId
    if (e.exit) {
      const zone = exitZone(e.text)
      if (zone && !open.has(id)) open.set(id, { at: e.t, zone })
    } else {
      const o = open.get(id)
      if (!o) continue
      trips.push({ plate: e.v.plate, out: o.at, back: e.t, ms: e.t - o.at, zone: titleName(o.zone) })
      open.delete(id)
    }
  }
  const zonesKnown = zones.length > 0 || units.some((v) => v.zones?.known && v.zones.inside?.length)
  const outside = [...open]
    .map(([id, o]) => ({ v: byId.get(id)!, o }))
    // The snapshot has the last word: a unit it places inside a zone is back, whatever the feed missed.
    .filter(({ v }) => !(v.zones?.known && (v.zones.inside ?? []).some((z) => z.area !== false)))
    .map(({ v, o }) => {
      const forMs = to - o.at
      return {
        plate: v.plate, driver: v.driver, left: titleName(o.zone), since: o.at, forMs,
        near: places.get(v.vehicleId) ?? null, lat: v.lat, lng: v.lng,
        silentSince: v.seenAt != null && to - v.seenAt > 2 * H ? v.seenAt : null,
        dispatch: v.dispatch, noDispatch: !v.dispatch, long: forMs > LONG_OUT_MS,
      }
    })
    .sort((a, b) => Number(b.noDispatch) - Number(a.noDispatch) || a.since - b.since)
  const totalOutMs = trips.reduce((n, x) => n + x.ms, 0)
  const outAndBack = {
    units: new Set(trips.map((x) => x.plate)).size, times: trips.length, totalMs: totalOutMs,
    avgMs: trips.length ? totalOutMs / trips.length : null,
    longest: trips.reduce<(typeof trips)[number] | null>((b, x) => (!b || x.ms > b.ms ? x : b), null),
  }

  // ── weighbridge ──
  let weighbridge: null | {
    tickets: number; tonnes: number; units: number; multiUnits: number
    bridges: Array<{ name: string; tickets: number; tonnes: number; busiest: string | null }>
    multi: Array<{ plate: string; driver: string | null; trips: number; tonnes: number; bridges: string[] }>
  } = null
  const loads: Array<NonNullable<ReturnType<typeof ticketLoad>> & { product: string; plate: string; driverName: string | null }> = []
  if (tickets) {
    const seenT = new Set<string>()
    for (const w of tickets) {
      const l = ticketLoad(w)
      if (!l || seenT.has(l.id) || !inShift(l.at)) continue
      seenT.add(l.id)
      loads.push({ ...l, product: w.productName || 'Sugarcane', plate: plateOf(l.vehicleId, w.vehiclePlate ?? w.vehicleNo), driverName: w.driverName ?? null })
    }
    const bridges = new Map<string, { name: string; tickets: number; kg: number; hours: Map<number, number> }>()
    for (const l of loads) {
      const name = l.where ?? 'Unknown'
      const b = bridges.get(name) ?? { name, tickets: 0, kg: 0, hours: new Map() }
      b.tickets += 1; b.kg += l.kg
      const h = eatHour(l.at); b.hours.set(h, (b.hours.get(h) ?? 0) + 1)
      bridges.set(name, b)
    }
    const byUnit = new Map<string, { plate: string; trips: number; kg: number; bridges: Set<string>; names: Array<string | null> }>()
    for (const l of loads) {
      const u = byUnit.get(l.plate) ?? { plate: l.plate, trips: 0, kg: 0, bridges: new Set(), names: [] }
      u.trips += 1; u.kg += l.kg; if (l.where) u.bridges.add(l.where); u.names.push(l.driverName)
      byUnit.set(l.plate, u)
    }
    const multi = [...byUnit.values()].filter((u) => u.trips > 1)
      .map((u) => ({ plate: u.plate, driver: driverOfPlate(u.plate) ?? (titleName(mostCommon(u.names)) || null), trips: u.trips, tonnes: round1(u.kg / 1000), bridges: [...u.bridges].map(titleName) }))
      .sort((a, b) => b.trips - a.trips || b.tonnes - a.tonnes)
    const hh = (h: number) => String(h).padStart(2, '0')
    weighbridge = {
      tickets: loads.length,
      tonnes: round1(loads.reduce((n, l) => n + l.kg, 0) / 1000),
      units: byUnit.size,
      multiUnits: multi.length,
      bridges: [...bridges.values()].map((b) => {
        const hr = [...b.hours].sort((x, y) => y[1] - x[1])[0]?.[0]
        return { name: titleName(b.name), tickets: b.tickets, tonnes: round1(b.kg / 1000), busiest: hr != null ? `${hh(hr)}:00–${hh((hr + 1) % 24)}:00` : null }
      }).sort((a, b) => b.tonnes - a.tonnes),
      multi,
    }
  }

  // ── products ferried ──
  const prod = new Map<string, { product: string; loads: number; units: Set<string>; kg: number; bags: number; where: Map<string, number>; source: string }>()
  const add = (name: string, row: { plate: string; kg: number; bags?: number | null; to: string | null; source: string }) => {
    const p = prod.get(name) ?? { product: name, loads: 0, units: new Set(), kg: 0, bags: 0, where: new Map(), source: row.source }
    p.loads += 1; p.units.add(row.plate); p.kg += row.kg; p.bags += row.bags ?? 0
    if (row.to) p.where.set(row.to, (p.where.get(row.to) ?? 0) + 1)
    prod.set(name, p)
  }
  for (const l of loads) add(titleName(l.product), { plate: l.plate, kg: l.kg, to: l.toMill ? 'Mill' : titleName(l.where), source: 'Weighbridge tickets' })
  const seenS = new Set<string>()
  for (const s of sales) {
    const t = ms(s.ts ?? s.time)
    if (!inShift(t) || seenS.has(s.id)) continue
    seenS.add(s.id)
    const p = parseSale(s.text)
    add(p.product, { plate: plateOf(s.vehicleId, s.plate), kg: p.tonnes != null ? p.tonnes * 1000 : 0, bags: p.bags, to: p.destination ? titleName(p.destination) : null, source: 'Sales dispatches' })
  }
  const products = [...prod.values()].map((p) => ({
    product: p.product, loads: p.loads, units: p.units.size, tonnes: round1(p.kg / 1000), bags: p.bags || null,
    where: [...p.where].sort((a, b) => b[1] - a[1]).map(([w, n]) => (p.where.size > 1 ? `${w} ${n}` : w)).join(', '), source: p.source,
  })).sort((a, b) => b.tonnes - a.tonnes)

  // Reporting = the tracker sent something since the shift began, not "engine on now".
  const reporting = units.filter((v) => v.seenAt != null && v.seenAt >= from).length
  return {
    from, to,
    fleet: { units: units.length, reporting },
    fuel: {
      refills: refills.length, refillL: sumL(refills), topRefills: [...refills].sort((a, b) => b.litres - a.litres).slice(0, TOP),
      drains, drainL: sumL(drains),
    },
    // Critical: only the drains a reviewer escalated (operator, 2026-10-31).
    theft: drains.filter((d) => d.escalated),
    breaches, breachTotal: breaches.reduce((n, b) => n + b.total, 0), dashcam: alarms != null,
    outside, outAndBack, zonesKnown,
    weighbridge,
    products,
  }
}

export type EndOfShift = ReturnType<typeof buildEndOfShift>
