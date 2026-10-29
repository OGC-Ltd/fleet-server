/**
 * Which reported event is which ledger row.
 *
 * ## Why a timestamp is not an identity
 *
 * The sync re-reads an overlapping window every cycle, so the same physical
 * event is reported many times. The ledger used to decide "have I seen this?"
 * by exact equality on the event's START timestamp — and Wialon does not hold
 * that timestamp still. While a drain is in progress the report re-clamps its
 * beginning on every execution, so each cycle produced a row the previous cycle
 * had never seen.
 *
 * Measured on the live account (MUFINDI: 008, 2026-08-03):
 *
 *   Wialon, settled:  2 drains,   371.1 L
 *   Ledger:          10 rows,   1553.3 L
 *
 * with ten `beganAt` values 15 minutes apart — the sync cadence, stamped into
 * the data. Analytics sums the ledger, so the fuel-loss figure and its cost
 * were over four times what the provider actually reported. The same pattern
 * ran through MUFINDI: EX 17 (3.8x) and MUFINDI: DZ 04 (6.0x); across a random
 * 36-vehicle sample it averaged 1.29x (KASULU) and 1.40x (SUKARI).
 *
 * ## What IS stable
 *
 * A tank can only be draining once. Two reports whose [began, detected]
 * intervals overlap are therefore the same physical drain, however much the
 * edges have moved — and two genuinely separate drains cannot overlap. That is
 * the whole rule for drains, and it collapses every duplicate observed on the
 * live account.
 *
 * A filling is near-instantaneous, so there is no interval to overlap. What the
 * repeated reports share instead is the tank state they describe: the same fill
 * re-reported minutes later still spans overlapping fuel LEVELS (CTR 23's
 * 20:46:31 `1191.5 → 1212.6` and 20:47:01 `1200.7 → 1212.6`). Two real fills
 * far enough apart to be distinct are separated by consumption, so their level
 * ranges do not overlap — and a vehicle does not refuel twice inside a quarter
 * of an hour anyway, which is what the time bound is for.
 *
 * Nothing here decides what happened. It decides only WHICH ROW to write, so
 * the provider's current answer replaces its previous answer instead of
 * accumulating beside it.
 */

/** How far apart two reports of one filling can sit. */
const FILL_WINDOW_MS = 15 * 60_000

/**
 * Bound used when neither report carries a fuel level, so the level test is
 * unavailable and time is all there is. Deliberately tight: without levels
 * there is nothing to distinguish a re-report from a genuine second fill.
 */
const FILL_BLIND_WINDOW_MS = 2 * 60_000

/**
 * How far after one drain ends a report of the SAME fall can start — see
 * sameDrain's re-clamp rule. Wider than one sync cycle (KTCC 189M's two
 * reports sat 15 min apart), far short of the gap between a machine's real
 * drains.
 */
const DRAIN_RECLAMP_GAP_MS = 20 * 60_000

/** How close two reports' tank levels must sit to describe one tank state. */
const DRAIN_LEVEL_MATCH_ML = 2_000

export interface DrainSpan {
  beganAt:    Date
  detectedAt: Date
  /** The provider's levels either side of the fall, when it gave them. */
  initialFuelLevelMl?: number | null
  finalFuelLevelMl?:   number | null
}

export interface FillPoint {
  filledAt:           Date
  initialFuelLevelMl: number | null
  finalFuelLevelMl:   number | null
}

/**
 * Do two drain reports describe the same drain?
 *
 * Closed-interval overlap, boundary included: a report ending exactly where
 * another begins is one drain the provider split across two executions, not
 * two drains that happened to be seamless. Inclusive comparison also keeps
 * INSTANTANEOUS drains working — Wialon emits those with `began == detected`,
 * a zero-length interval that a strict test could never match, not even
 * against itself.
 *
 * ## Re-clamped instants
 *
 * Overlap alone misses one case. Wialon also re-clamps an INSTANTANEOUS drain
 * to a different minute between executions, and two zero-length intervals a few
 * minutes apart never overlap. Each version became its own row, each was judged
 * and announced, and the second usually arrived hours late from the settle
 * pass. Measured 23–30 Oct:
 *
 *   KCX 795S   16:30 54→43 L and 16:38 54→43 L    our tank fell 10 L, two SIPHON calls
 *   KTCC 189M  16:42 35→24 L and 16:58 37→24 L    the second posted 19 h late
 *   EX 04      14:00 234→212 L and 14:04 222→212 L
 *
 * What the versions share is the tank state they end at. A report that starts
 * shortly after another ends, finishes at the same level, and never starts
 * above where the first started describes no fuel the first did not already
 * account for: the same fall, seen from another window. A real second drain
 * ends lower, and fuel that arrived in between starts the second report above
 * the first. Needs both reports' levels; without them, overlap is the rule.
 */
export function sameDrain(a: DrainSpan, b: DrainSpan): boolean {
  if (a.beganAt.getTime() <= b.detectedAt.getTime() && b.beganAt.getTime() <= a.detectedAt.getTime()) return true
  const [first, second] = a.beganAt <= b.beganAt ? [a, b] : [b, a]
  if (second.beganAt.getTime() - first.detectedAt.getTime() > DRAIN_RECLAMP_GAP_MS) return false
  if (first.finalFuelLevelMl == null || second.finalFuelLevelMl == null
    || first.initialFuelLevelMl == null || second.initialFuelLevelMl == null) return false
  return Math.abs(first.finalFuelLevelMl - second.finalFuelLevelMl) <= DRAIN_LEVEL_MATCH_ML
      && second.initialFuelLevelMl <= first.initialFuelLevelMl + DRAIN_LEVEL_MATCH_ML
}

/**
 * The fuel levels a filling spans, lowest first.
 *
 * A row missing one end collapses to a point at the end it has — enough to
 * match against, because repeated reports of one fill agree on the final level
 * even while they disagree about where it started.
 */
function levelRange(f: FillPoint): { lo: number; hi: number } | null {
  const ends = [f.initialFuelLevelMl, f.finalFuelLevelMl].filter((n): n is number => n != null)
  if (ends.length === 0) return null
  return { lo: Math.min(...ends), hi: Math.max(...ends) }
}

/** Do two filling reports describe the same filling? */
export function sameFilling(a: FillPoint, b: FillPoint): boolean {
  const apart = Math.abs(a.filledAt.getTime() - b.filledAt.getTime())
  const ra = levelRange(a)
  const rb = levelRange(b)
  if (!ra || !rb) return apart <= FILL_BLIND_WINDOW_MS
  if (apart > FILL_WINDOW_MS) return false
  return ra.lo <= rb.hi && rb.lo <= ra.hi
}

/**
 * The ledger row a reported event belongs to, or null for a genuinely new one.
 *
 * `taken` holds the ids already claimed earlier in this pass. One report can
 * legitimately return two distinct drains that both overlap one stale row, and
 * without this they would both rewrite it and the second would silently erase
 * the first.
 *
 * Ties break on proximity in time, so when several rows match, the reported
 * event lands on the nearest one rather than on whichever the query returned
 * first.
 */
export function matchRow<T extends { id: string }>(
  rows:  readonly T[],
  taken: ReadonlySet<string>,
  isSame:   (row: T) => boolean,
  distance: (row: T) => number,
): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const row of rows) {
    if (taken.has(row.id) || !isSame(row)) continue
    const d = distance(row)
    if (d < bestDistance) { best = row; bestDistance = d }
  }
  return best
}
