/**
 * Unit usage review — one vehicle over a chosen period, worked out from its
 * Wialon message history.
 *
 * The method is the one used by hand for the August–September 2026 reviews
 * (KDP 365T, KDW 648X, 634X, 646X, 662X), proofread against the odometer and
 * the GPS track on each of them, and kept identical here so a review built in
 * the dashboard reproduces those numbers:
 *
 *   · days are Kenyan (EAT, UTC+3) calendar days;
 *   · a step between two messages belongs to the EARLIER message, and its
 *     duration is capped at 5 minutes — a tracker that goes quiet while parked
 *     must not be read as hours of driving or idling;
 *   · drive time = steps that start at ≥ 5 km/h; engine time = steps that
 *     start with the ignition on; idle = engine − drive;
 *   · distance = the tracker's odometer (Teltonika io_16, metres) step by
 *     step, carried forward over messages that omit it. A unit that sends no
 *     odometer is measured on the GPS track instead, and so is any single step
 *     whose odometer jump is physically impossible;
 *   · a stop = a run of messages under 3 km/h lasting 10 minutes or more, put
 *     at the median of its fixes;
 *   · places = stops grouped greedily within 400 m of a running,
 *     duration-weighted centre; place 1 is where the unit spent most time;
 *   · trips = the driving between two consecutive stops, kept when ≥ 0.5 km.
 *
 * Pure: messages in, review out. Fetching and naming places live elsewhere.
 */

export const TZ_OFFSET_MS = 3 * 3_600_000          // EAT has no daylight saving
export const STEP_CAP_S = 300
export const DRIVE_KMH = 5
export const STOP_KMH = 3
export const STOP_MIN_S = 600
export const PLACE_RADIUS_M = 400
export const TRIP_MIN_KM = 0.5
export const MOVED_DAY_KM = 1
/** Faster than this between two fixes is a GPS or odometer glitch, not driving. */
export const MAX_PLAUSIBLE_KMH = 160

export interface ReviewMessage {
  /** Unix seconds. */
  t: number
  lat: number | null
  lng: number | null
  speed: number
  course: number | null
  /** Odometer, metres, as sent (not yet carried forward). */
  odoM: number | null
  ign: boolean | null
  /** Where the message came from: our own telemetry table, or Wialon's history. */
  src?: 'db' | 'wialon'
}

export interface ReviewDay {
  date: string
  km: number
  driveH: number
  engineH: number | null
  idleH: number | null
  maxKmh: number
  avgKmh: number | null
  moved: boolean
  trips: number
  stops: number
  firstMove: number | null
  lastMove: number | null
  odoStartKm: number | null
  odoEndKm: number | null
  messages: number
  source: 'db' | 'wialon' | 'mixed' | null
}

export interface ReviewStop {
  id: number
  start: number
  end: number
  min: number
  lat: number
  lng: number
  place: number
  overnight: boolean
}

export interface ReviewPlace {
  id: number
  lat: number
  lng: number
  hours: number
  visits: number
  days: number
  share: number
  firstSeen: number
  lastSeen: number
  name: string | null
  /** The business or premises at the spot: OpenStreetMap's on the build
   *  (usage-review.poi), replaced on a download by Google's when the page
   *  looked one up ("West Kenya Sugar - Lake Agro workshop"). */
  exactName?: string | null
  /** What the named place is ("Mechanical", "Banking", "Work") — what the
   *  unit most likely stopped there for: read from its name and its OpenStreetMap
   *  or Google type, or by the model (usage-review.activity-ai). */
  activity?: string | null
  /** OpenStreetMap was asked for a business here on the build, found or not,
   *  so the page does not ask again. */
  poiTried?: boolean
  /** Work site, the home area, or elsewhere — see usage-review.areas. Set on
   *  a download only, where the organisation's sites are read. */
  kind?: 'work' | 'home' | 'elsewhere'
  /** The site a work place stands at ("Nzoia cw bridge", a geofence name). */
  site?: string | null
  /** Set when the company's own ground named the place — a site-plan survey
   *  or one of its geofences (usage-review.siteplans). `exactName` is then
   *  that name, and nothing looked up later replaces it. */
  nameFrom?: 'site-plan' | 'geofence' | null
  /** Nights (02:00 EAT) the unit stood here. */
  nights?: number
  area: string | null
  county: string | null
  country: string | null
  address: string | null
}

export interface ReviewTrip {
  id: number
  start: number
  end: number
  min: number
  driveMin: number
  km: number
  maxKmh: number
  avgKmh: number | null
  fromStop: number
  toStop: number
  fromPlace: number
  toPlace: number
  from: [number, number]
  to: [number, number]
}

export interface ReviewHour { date: string; hour: number; driveMin: number; engineMin: number | null; km: number }

export interface ReviewPoint {
  t: number; lat: number; lng: number; speed: number; course: number | null
  ign: boolean | null; odoKm: number | null; moving: boolean
}

export interface UsageReview {
  period: { from: string; to: string; days: number; startMs: number; endMs: number }
  summary: {
    calendarDays: number
    activeDays: number
    km: number
    driveH: number
    engineH: number | null
    idleH: number | null
    driveHPerDay: number
    driveHPerActiveDay: number | null
    kmPerDay: number
    kmPerActiveDay: number | null
    avgMovingKmh: number | null
    maxKmh: number
    stoppedH: number
    stops: number
    places: number
    trips: number
    longestDay: { date: string; km: number } | null
  }
  quality: {
    messages: number
    distanceSource: 'odometer' | 'gps' | 'mixed'
    /** Days read from our database, and from Wialon. */
    daysFromDb: number
    daysFromWialon: number
    ignition: boolean
    /** |GPS − odometer| over the period, % of odometer. Null without an odometer. */
    gpsVsOdometerPct: number | null
    worstDay: { date: string; pct: number } | null
    /** Gaps over 5 minutes across which the odometer moved > 500 m. */
    movingGaps: number
    movingGapKm: number
    glitchSteps: number
  }
  days: ReviewDay[]
  hours: ReviewHour[]
  stops: ReviewStop[]
  places: ReviewPlace[]
  trips: ReviewTrip[]
  /** Per day, the route simplified for drawing: [lat, lng] pairs. */
  tracks: { date: string; path: [number, number][] }[]
  points: ReviewPoint[]
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const R_EARTH = 6_371_000
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180
  const dLa = (bLat - aLat) * r
  const dLo = (bLng - aLng) * r
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLo / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The EAT calendar day of an instant, "YYYY-MM-DD". */
export const eatDay = (ms: number): string => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
const eatHour = (ms: number): number => new Date(ms + TZ_OFFSET_MS).getUTCHours()
/** Midnight EAT at the start of a "YYYY-MM-DD" day, as an instant. */
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) - TZ_OFFSET_MS

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const valid = (m: ReviewMessage): m is ReviewMessage & { lat: number; lng: number } =>
  m.lat != null && m.lng != null && Number.isFinite(m.lat) && Number.isFinite(m.lng) && !(m.lat === 0 && m.lng === 0)

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (!n) return NaN
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/** Perpendicular-distance simplification (Douglas–Peucker) in metres, iterative. */
export function simplify(path: [number, number][], tolM: number): [number, number][] {
  if (path.length < 3) return path
  const keep = new Uint8Array(path.length)
  keep[0] = 1; keep[path.length - 1] = 1
  const stack: [number, number][] = [[0, path.length - 1]]
  const k = Math.cos((path[0]![0] * Math.PI) / 180) * 111_320
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ay, ax] = path[a]!; const [by, bx] = path[b]!
    const x1 = ax * k, y1 = ay * 110_540, x2 = bx * k, y2 = by * 110_540
    const dx = x2 - x1, dy = y2 - y1
    const len2 = dx * dx + dy * dy
    let best = -1, bestD = tolM
    for (let i = a + 1; i < b; i++) {
      const px = path[i]![1] * k, py = path[i]![0] * 110_540
      let d: number
      if (len2 === 0) d = Math.hypot(px - x1, py - y1)
      else {
        const u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
        d = Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy))
      }
      if (d > bestD) { bestD = d; best = i }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]) }
  }
  return path.filter((_, i) => keep[i])
}

// ─── the review ──────────────────────────────────────────────────────────────

/**
 * @param messages every message from somewhat BEFORE the period to somewhat
 *   AFTER it (a few hours either side), so the odometer can be carried in and
 *   the last step of the period has an end.
 * @param from first EAT day, "YYYY-MM-DD"; @param to last EAT day, inclusive.
 */
export function buildUsageReview(messages: ReviewMessage[], from: string, to: string): UsageReview {
  const startMs = dayStartMs(from)
  const endMs = dayStartMs(to) + 86_400_000

  // Sorted, one message per second.
  const all: ReviewMessage[] = []
  for (const m of [...messages].sort((a, b) => a.t - b.t)) {
    if (all.length && all[all.length - 1]!.t === m.t) continue
    all.push(m)
  }
  const n = all.length

  // Odometer carried forward; is it the unit's distance source? Only Wialon
  // messages carry one (our table stores none), so it is judged on those, and
  // never carried across a database message: a step that touches one is
  // measured on the GPS track instead.
  const fromWialon = all.filter(m => m.src !== 'db')
  const withOdo = fromWialon.filter(m => m.odoM != null && m.odoM > 0).length
  const useOdo = fromWialon.length > 0 && withOdo / fromWialon.length >= 0.5
  const odo: (number | null)[] = new Array(n).fill(null)
  let lastOdo: number | null = null
  for (let i = 0; i < n; i++) {
    const m = all[i]!
    if (m.src === 'db') { lastOdo = null; continue }
    if (m.odoM != null && m.odoM > 0) lastOdo = m.odoM
    odo[i] = lastOdo
  }

  // Step i → i+1, owned by message i.
  const dt = new Float64Array(n)        // seconds, uncapped
  const dtc = new Float64Array(n)       // capped
  for (let i = 0; i < n - 1; i++) {
    dt[i] = all[i + 1]!.t - all[i]!.t
    dtc[i] = Math.min(dt[i]!, STEP_CAP_S)
  }
  // GPS legs, fix to fix, credited to the fix the leg starts from. A leg
  // faster than MAX_PLAUSIBLE_KMH is a jump in the fix and counts nothing.
  const gpsM = new Float64Array(n)
  for (let i = 0, prev = -1; i < n; i++) {
    const q = all[i]!
    if (!valid(q)) continue
    if (prev >= 0) {
      const p = all[prev]!
      const span = q.t - p.t
      const d = haversineM(p.lat!, p.lng!, q.lat, q.lng)
      if (span > 0 && (d / span) * 3.6 < MAX_PLAUSIBLE_KMH) gpsM[prev] = d
    }
    prev = i
  }
  const stepM = new Float64Array(n)     // metres, the distance source
  const odoStep = new Uint8Array(n)     // 1 where the step was measured on the odometer
  let glitchSteps = 0
  for (let i = 0; i < n - 1; i++) {
    const o0 = odo[i], o1 = odo[i + 1]
    if (!useOdo || o0 == null || o1 == null) { stepM[i] = gpsM[i]!; continue }
    odoStep[i] = 1
    const d = o1 - o0
    if (d <= 0) stepM[i] = 0
    else if (d > 5_000 && (dt[i]! <= 0 || (d / dt[i]!) * 3.6 > MAX_PLAUSIBLE_KMH)) { stepM[i] = gpsM[i]!; glitchSteps++ }
    else stepM[i] = d
  }
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + stepM[i - 1]!

  const hasIgn = all.some(m => m.ign != null)
  const inP = (m: ReviewMessage) => m.t * 1000 >= startMs && m.t * 1000 < endMs
  let i0 = 0; while (i0 < n && !inP(all[i0]!)) i0++
  let i1 = n; while (i1 > i0 && !inP(all[i1 - 1]!)) i1--      // [i0, i1)

  // ── days and hours ──
  const dayKeys = daysBetween(from, to)
  const dayIx = new Map(dayKeys.map((d, k) => [d, k]))
  const D = dayKeys.map(date => ({
    date, m: 0, drive: 0, eng: 0, max: 0, first: null as number | null, last: null as number | null,
    o0: null as number | null, o1: null as number | null, msgs: 0,
    odoM: 0, gpsOnOdoM: 0, db: 0, wl: 0,
  }))
  const H = dayKeys.map(() => Array.from({ length: 24 }, () => ({ drive: 0, eng: 0, m: 0 })))
  let movingGaps = 0, movingGapM = 0
  for (let i = i0; i < i1; i++) {
    const m = all[i]!
    const ms = m.t * 1000
    const k = dayIx.get(eatDay(ms))
    if (k == null) continue
    const d = D[k]!; const h = H[k]![eatHour(ms)]!
    d.msgs++
    if (m.src === 'db') d.db++; else d.wl++
    if (odoStep[i]) { d.odoM += stepM[i]!; d.gpsOnOdoM += gpsM[i]! }
    d.m += stepM[i]!; h.m += stepM[i]!
    if (m.speed >= DRIVE_KMH) {
      d.drive += dtc[i]!; h.drive += dtc[i]!
      if (d.first == null) d.first = ms
      d.last = ms
    }
    if (m.ign) { d.eng += dtc[i]!; h.eng += dtc[i]! }
    if (m.speed > d.max) d.max = m.speed
    if (odo[i] != null) { if (d.o0 == null) d.o0 = odo[i]!; d.o1 = odo[i]! }
    if (dt[i]! > STEP_CAP_S && stepM[i]! > 500) { movingGaps++; movingGapM += stepM[i]! }
  }

  // ── stops (inside the period) ──
  const stopRuns: { t0: number; t1: number; lat: number; lng: number }[] = []
  for (let i = i0; i < i1;) {
    if (all[i]!.speed >= STOP_KMH) { i++; continue }
    let j = i
    while (j < i1 && all[j]!.speed < STOP_KMH) j++
    const t0 = all[i]!.t, t1 = all[j - 1]!.t
    if (t1 - t0 >= STOP_MIN_S) {
      const fixes = all.slice(i, j).filter(valid).slice(0, 400)
      if (fixes.length) stopRuns.push({ t0, t1, lat: median(fixes.map(f => f.lat!)), lng: median(fixes.map(f => f.lng!)) })
    }
    i = j
  }

  // ── places: greedy clustering, membership kept ──
  const clusters: { lat: number; lng: number; sec: number }[] = []
  const member: number[] = []
  for (const s of stopRuns) {
    const dur = s.t1 - s.t0
    let hit = -1
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c]!
      if (haversineM(s.lat, s.lng, cl.lat, cl.lng) < PLACE_RADIUS_M) { hit = c; break }
    }
    if (hit < 0) { clusters.push({ lat: s.lat, lng: s.lng, sec: dur }); member.push(clusters.length - 1); continue }
    const cl = clusters[hit]!
    const w = cl.sec
    cl.lat = (cl.lat * w + s.lat * dur) / (w + dur)
    cl.lng = (cl.lng * w + s.lng * dur) / (w + dur)
    cl.sec += dur
    member.push(hit)
  }
  const order = clusters.map((_, c) => c).sort((a, b) => clusters[b]!.sec - clusters[a]!.sec)
  const rank = new Map(order.map((c, k) => [c, k + 1]))

  const stops: ReviewStop[] = stopRuns.map((s, k) => ({
    id: k + 1, start: s.t0 * 1000, end: s.t1 * 1000, min: r1((s.t1 - s.t0) / 60),
    lat: s.lat, lng: s.lng, place: rank.get(member[k]!)!,
    overnight: eatDay(s.t1 * 1000) !== eatDay(s.t0 * 1000),
  }))
  const stoppedSec = stopRuns.reduce((a, s) => a + s.t1 - s.t0, 0)
  const places: ReviewPlace[] = order.map((c, k) => {
    const mine = stops.filter(s => s.place === k + 1)
    const sec = clusters[c]!.sec
    return {
      id: k + 1, lat: clusters[c]!.lat, lng: clusters[c]!.lng, hours: r2(sec / 3600), visits: mine.length,
      days: new Set(mine.map(s => eatDay(s.start))).size,
      share: stoppedSec ? r2((sec / stoppedSec) * 100) : 0,
      firstSeen: Math.min(...mine.map(s => s.start)), lastSeen: Math.max(...mine.map(s => s.end)),
      name: null, area: null, county: null, country: null, address: null,
    }
  })

  // ── trips between consecutive stops ──
  const idxAt = (tSec: number) => { // first message with t >= tSec
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid]!.t < tSec) lo = mid + 1; else hi = mid }
    return lo
  }
  const trips: ReviewTrip[] = []
  for (let k = 0; k + 1 < stopRuns.length; k++) {
    const a = stopRuns[k]!, b = stopRuns[k + 1]!
    const ia = idxAt(a.t1), ib = Math.min(idxAt(b.t0), n - 1)
    if (ib - ia < 1) continue
    const km = (cum[ib]! - cum[ia]!) / 1000
    if (km < TRIP_MIN_KM) continue
    let drive = 0, max = 0
    for (let i = ia; i < ib; i++) {
      if (all[i]!.speed >= DRIVE_KMH) drive += dtc[i]!
      if (all[i]!.speed > max) max = all[i]!.speed
    }
    if (all[ib]!.speed > max) max = all[ib]!.speed
    trips.push({
      id: trips.length + 1, start: a.t1 * 1000, end: b.t0 * 1000, min: r1((b.t0 - a.t1) / 60),
      driveMin: r1(drive / 60), km: r2(km), maxKmh: Math.round(max),
      avgKmh: drive > 0 ? r1(km / (drive / 3600)) : null,
      fromStop: k + 1, toStop: k + 2, fromPlace: stops[k]!.place, toPlace: stops[k + 1]!.place,
      from: [a.lat, a.lng], to: [b.lat, b.lng],
    })
  }

  const stopsByDay = new Map<string, number>(); for (const s of stops) { const d = eatDay(s.start); stopsByDay.set(d, (stopsByDay.get(d) ?? 0) + 1) }
  const tripsByDay = new Map<string, number>(); for (const t of trips) { const d = eatDay(t.start); tripsByDay.set(d, (tripsByDay.get(d) ?? 0) + 1) }

  const days: ReviewDay[] = D.map(d => {
    const km = d.m / 1000, driveH = d.drive / 3600, engH = d.eng / 3600
    return {
      date: d.date, km: r2(km), driveH: r2(driveH),
      engineH: hasIgn ? r2(engH) : null, idleH: hasIgn ? r2(Math.max(0, engH - driveH)) : null,
      maxKmh: Math.round(d.max), avgKmh: driveH > 0 ? r1(km / driveH) : null,
      moved: km >= MOVED_DAY_KM, trips: tripsByDay.get(d.date) ?? 0, stops: stopsByDay.get(d.date) ?? 0,
      firstMove: d.first, lastMove: d.last,
      odoStartKm: useOdo && d.o0 != null ? r2(d.o0 / 1000) : null,
      odoEndKm: useOdo && d.o1 != null ? r2(d.o1 / 1000) : null,
      messages: d.msgs,
      source: d.msgs === 0 ? null : d.db && d.wl ? 'mixed' : d.db ? 'db' : 'wialon',
    }
  })
  const hours: ReviewHour[] = D.flatMap((d, k) => H[k]!.map((h, hour) => ({
    date: d.date, hour, driveMin: r1(h.drive / 60), engineMin: hasIgn ? r1(h.eng / 60) : null, km: r2(h.m / 1000),
  })))

  // ── per-day route, simplified ──
  const tracks: UsageReview['tracks'] = []
  {
    let cur: [number, number][] = []; let curDay = ''
    const flush = () => { if (cur.length > 1) tracks.push({ date: curDay, path: simplify(cur, 25) }); cur = [] }
    for (let i = i0; i < i1; i++) {
      const m = all[i]!
      if (!valid(m)) continue
      const day = eatDay(m.t * 1000)
      if (day !== curDay) { flush(); curDay = day }
      const last = cur[cur.length - 1]
      if (last && haversineM(last[0], last[1], m.lat, m.lng) < 15) continue
      cur.push([Math.round(m.lat * 1e5) / 1e5, Math.round(m.lng * 1e5) / 1e5])
    }
    flush()
  }

  const points: ReviewPoint[] = []
  for (let i = i0; i < i1; i++) {
    const m = all[i]!
    if (!valid(m)) continue
    points.push({
      t: m.t * 1000, lat: m.lat, lng: m.lng, speed: m.speed, course: m.course, ign: m.ign,
      odoKm: useOdo && odo[i] != null ? Math.round(odo[i]! / 10) / 100 : null, moving: m.speed >= DRIVE_KMH,
    })
  }

  // ── summary and checks ──
  const nDays = days.length
  const active = days.filter(d => d.moved).length
  const totM = D.reduce((a, d) => a + d.m, 0)
  const driveS = D.reduce((a, d) => a + d.drive, 0)
  const engS = D.reduce((a, d) => a + d.eng, 0)
  const totKm = totM / 1000, driveH = driveS / 3600, engH = engS / 3600
  const longest = days.reduce<ReviewDay | null>((b, d) => (!b || d.km > b.km ? d : b), null)

  let gpsVsOdometerPct: number | null = null
  let worstDay: { date: string; pct: number } | null = null
  // Compared only where the odometer measured the step.
  const odoTot = D.reduce((a, d) => a + d.odoM, 0)
  if (useOdo && odoTot > 0) {
    const gpsTot = D.reduce((a, d) => a + d.gpsOnOdoM, 0)
    gpsVsOdometerPct = r1((Math.abs(gpsTot - odoTot) / odoTot) * 100)
    for (const d of D) {
      if (d.odoM < 10_000) continue
      const pct = r1((Math.abs(d.gpsOnOdoM - d.odoM) / d.odoM) * 100)
      if (!worstDay || pct > worstDay.pct) worstDay = { date: d.date, pct }
    }
  }

  return {
    period: { from, to, days: nDays, startMs, endMs },
    summary: {
      calendarDays: nDays, activeDays: active,
      km: r1(totKm), driveH: r1(driveH),
      engineH: hasIgn ? r1(engH) : null, idleH: hasIgn ? r1(Math.max(0, engH - driveH)) : null,
      driveHPerDay: nDays ? r2(driveH / nDays) : 0,
      driveHPerActiveDay: active ? r2(driveH / active) : null,
      kmPerDay: nDays ? r1(totKm / nDays) : 0,
      kmPerActiveDay: active ? r1(totKm / active) : null,
      avgMovingKmh: driveH > 0 ? r1(totKm / driveH) : null,
      maxKmh: Math.max(0, ...days.map(d => d.maxKmh)),
      stoppedH: r1(stoppedSec / 3600), stops: stops.length, places: places.length, trips: trips.length,
      longestDay: longest && longest.km > 0 ? { date: longest.date, km: longest.km } : null,
    },
    quality: {
      messages: i1 - i0,
      distanceSource: !useOdo ? 'gps' : days.some(d => d.source === 'db' || d.source === 'mixed') ? 'mixed' : 'odometer',
      daysFromDb: days.filter(d => d.source === 'db' || d.source === 'mixed').length,
      daysFromWialon: days.filter(d => d.source === 'wialon' || d.source === 'mixed').length,
      ignition: hasIgn,
      gpsVsOdometerPct, worstDay, movingGaps, movingGapKm: r1(movingGapM / 1000), glitchSteps,
    },
    days, hours, stops, places, trips, tracks, points,
  }
}

/** Fuel at a km/L rate — an estimate, recomputed whenever the rate changes. */
export function fuelOf(km: number, kmpl: number | null): number | null {
  return kmpl && kmpl > 0 ? r1(km / kmpl) : null
}
