// Fleet AI Insight — an hourly operations brief written by OpenAI (gpt-5-nano
// acting as the fleet's duty analyst) over the shift in progress, framed by the
// SAME aggregates the Analytics, Drivers and Maintenance pages render.
//
// The brief leads with what has physically happened today — units through the
// gate, where they went, which fuel exceptions are open and how many of those
// are confirmed losses — because that is what the manager reading it can still
// act on. The 7-30 day aggregates set the risk verdict; they are no longer the
// headline. See collectToday and SYSTEM_PROMPT.
//
// Rendering is seamless because the model is NEVER on the request path:
// startAiInsightWarmer() generates each org's brief at boot and then every
// REFRESH_MS (1 hour), and the endpoint serves whatever is in memory
// instantly. A cold miss (first request before the boot warm finishes) kicks
// a background generation and returns { insight: null } so clients show
// their local heuristic summary until the brief lands — no spinner, no wait.
//
// No OPENAI_API_KEY → { configured: false } and clients keep the local
// summary permanently.

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { getDriversOverview, DEFAULT_DRIVER_WINDOW_DAYS } from '../analytics/drivers-overview.cache.js'
import { getDeliveriesAnalytics } from '../analytics/deliveries.cache.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance, DEFAULT_HISTORY_WINDOW_DAYS } from '../telemetry/maintenance.cache.js'

export interface AiInsight {
  msg:         string
  risk:        'Low' | 'Medium' | 'High'
  activeCount: number
  totalCount:  number
  generatedAt: string
}
export interface AiInsightResponse {
  configured: boolean
  insight:    AiInsight | null
}

const REFRESH_MS = 60 * 60_000   // regenerate each org's brief hourly
const insights = new Map<string, AiInsightResponse>()
const generating = new Set<string>()

// ── facts: the same aggregates the three dashboard pages consume ────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const halfDelta = (values: number[]) => {
  if (values.length < 2) return null
  const half = Math.max(1, Math.floor(values.length / 2))
  const cur = sum(values.slice(-half)), prev = sum(values.slice(-2 * half, -half))
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null
}

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

/**
 * TODAY, on the ground — the shift the operator is actually standing in.
 *
 * The brief used to be built entirely from 7-, 14- and 30-day aggregates, which
 * is why it read like a monthly report: an operator at 09:00 was told about
 * 30-day tonnage trends and never about the seventy units that had just gone
 * through the gate. Those windows still frame the risk call, but the lead
 * sentence has to be this morning's movement and this morning's exceptions.
 *
 * Every figure here is measured from rows we already own:
 *
 *   - a run is DISPATCHED when the paperwork was raised, and LEFT THE GATE only
 *     once lib/yard-departure watched it clear the barrier (feed id `yd-<id>`).
 *     On this fleet the two routinely differ by hours — about a quarter of open
 *     dispatches are still standing in the yard — so collapsing them into one
 *     number would report trucks as gone that are parked outside the office.
 *   - a fuel issue NEEDS INVESTIGATING only on a LOSS verdict: the level stayed
 *     down, so the fuel really went. PENDING is still inside its settle window
 *     and REDISTRIBUTION has been actively disproved (see fuel-adjudication) —
 *     lumping those in is how "19 raised" becomes 19 chases, which is the exact
 *     over-reporting the adjudicator was written to stop.
 */
export async function collectToday(orgId: string) {
  const dayStart = fleetDayStart()
  const now = new Date()

  const [dispatches, thefts] = await Promise.all([
    prisma.dispatch.findMany({
      where:  { organisationId: orgId, dispatchedAt: { gte: dayStart } },
      select: { id: true, destination: true, actualReturnAt: true },
    }),
    prisma.fuelTheft.findMany({
      where:  { vehicle: { organisationId: orgId }, detectedAt: { gte: dayStart } },
      select: { verdict: true, stolenMl: true },
    }),
  ])

  // Which of those runs has actually been SEEN leaving. Keyed on the dispatch,
  // exactly as yard-departure mints it, so this counts observed crossings and
  // not paperwork.
  const departed = new Set<string>()
  if (dispatches.length) {
    const rows = await prisma.notification.findMany({
      where:  { organisationId: orgId, feedId: { in: dispatches.map(d => `yd-${d.id}`) } },
      select: { feedId: true },
    })
    for (const r of rows) departed.add(r.feedId.slice(3))
  }

  // Dispatchers type the destination freehand and the casing wanders, so group
  // on the same UPPER(TRIM()) key DispatchDestination uses. Unnamed destinations
  // are counted apart rather than pooled under a made-up label.
  const byDest = new Map<string, { destination: string; dispatched: number; leftGate: number }>()
  let destinationNotRecorded = 0
  for (const d of dispatches) {
    const key = d.destination?.trim().toUpperCase()
    if (!key) { destinationNotRecorded++; continue }
    const row = byDest.get(key) ?? { destination: key, dispatched: 0, leftGate: 0 }
    row.dispatched++
    if (departed.has(d.id)) row.leftGate++
    byDest.set(key, row)
  }
  const ranked = [...byDest.values()].sort((a, b) => b.dispatched - a.dispatched)
  const top    = ranked.slice(0, 6)

  const verdicts = (v: string) => thefts.filter(t => t.verdict === v)
  const losses   = verdicts('LOSS')

  return {
    asOfLocal: clockFmt.format(now),
    /** 'this morning' before noon, so the model cannot narrate an afternoon as one. */
    sinceLabel: Number(clockFmt.format(now).slice(0, 2)) < 12 ? 'this morning' : 'so far today',
    /**
     * Has anything actually happened yet?
     *
     * The fleet day starts at local midnight, so a brief generated in the small
     * hours is asked to describe a shift that has not begun — and the first
     * version of this prompt dutifully narrated it: "left gate: 0 this morning;
     * no destinations listed. Fuel issues raised: 0". Four zeros is not a
     * briefing. Stated as one boolean so the prompt can branch on it instead of
     * inferring emptiness from a scatter of zeroes it has to check one by one.
     */
    quiet: dispatches.length === 0 && thefts.length === 0,
    dispatchesRaised: dispatches.length,
    leftGate:         departed.size,
    /** Raised but not yet seen past the barrier — still standing in the yard. */
    stillInYard:      dispatches.length - departed.size,
    returned:         dispatches.filter(d => d.actualReturnAt).length,
    byDestination:    top,
    destinationsNotShown: Math.max(0, ranked.length - top.length),
    destinationNotRecorded,
    fuelIssues: {
      raised:            thefts.length,
      needInvestigating: losses.length,
      stillSettling:     verdicts('PENDING').length,
      ruledOut:          verdicts('REDISTRIBUTION').length,
      unverifiable:      verdicts('UNVERIFIED').length,
      litresConfirmedLost: losses.length
        ? Math.round(losses.reduce((s, t) => s + t.stolenMl, 0) / 100) / 10
        : 0,
    },
  }
}

async function collectFacts(orgId: string) {
  const [snapshot, drivers, deliveries, history, maint, today] = await Promise.all([
    getFleetSnapshotCached(orgId),
    getDriversOverview(orgId, DEFAULT_DRIVER_WINDOW_DAYS),
    getDeliveriesAnalytics(orgId, 30),
    getMaintenanceHistoryCached(orgId, DEFAULT_HISTORY_WINDOW_DAYS),
    getOrgVehicleMaintenance(orgId),
    collectToday(orgId),
  ])

  const activeCount = snapshot.filter(v => v.engineOn).length
  const totalCount  = snapshot.length
  const roster      = drivers.drivers
  const weekAgo     = Date.now() - 7 * 86_400_000
  const hist30      = history.slice(-30)
  const hist14      = history.slice(-14)

  const facts = {
    fleetNow: {
      vehicles: totalCount,
      enginesOn: activeCount,
      lowFuel: snapshot.filter(v => v.lowFuel).length,
      inMaintenance: snapshot.filter(v => (v as { inMaintenance?: boolean }).inMaintenance).length,
    },
    // ── the shift in progress — see collectToday ──
    today,
    // ── Drivers page ──
    drivers: {
      count: roster.length,
      avgRating: roster.length ? Math.round(roster.reduce((s, d) => s + d.rating, 0) / roster.length * 100) / 100 : null,
      below4:    roster.filter(d => d.rating < 4).length,
      fuelTheftCases:    sum(roster.map(d => d.fuelTheftCases)),
      overspeedingCases: sum(roster.map(d => d.overspeedingCases)),
      topByTonnes: roster.slice(0, 3).map(d => ({ name: d.fullName, tonnes: d.tonnes, trips: d.trips, rating: d.rating })),
      lowestRated: [...roster].sort((a, b) => a.rating - b.rating).slice(0, 2)
        .map(d => ({ name: d.fullName, rating: d.rating, overspeedingCases: d.overspeedingCases })),
    },
    // ── Analytics page (30-day deliveries) ──
    deliveries30d: {
      trips: deliveries.totals.trips,
      tonnes: deliveries.totals.tonnes,
      distanceKm: deliveries.totals.distanceKm,
      timelyPct: deliveries.deliveries.total > 0
        ? Math.round((deliveries.deliveries.timely / deliveries.deliveries.total) * 100) : null,
      interrupted: deliveries.deliveries.interrupted,
      tonnesTrendPctHalfOverHalf: halfDelta(deliveries.byDay.map(d => d.tonnes)),
      tripsTrendPctHalfOverHalf:  halfDelta(deliveries.byDay.map(d => d.trips)),
      topProducts: deliveries.products.slice(0, 3).map(p => ({ product: p.product, tonnes: p.tonnes })),
      busiestDepots: deliveries.depots.slice(0, 3).map(d => ({ depot: d.depot, trips: d.trips })),
    },
    // ── Maintenance page ──
    maintenance: {
      last30d: {
        distanceKm: sum(hist30.map(h => h.distanceKm)),
        overspeedingIncidents: sum(hist30.map(h => h.overspeedingCount)),
        fuelInconsistencyIncidents: sum(hist30.map(h => h.fuelInconsistencyCount)),
        incidentTrendPctHalfOverHalf: halfDelta(hist14.map(h => h.overspeedingCount + h.fuelInconsistencyCount)),
      },
      last7d: {
        servicesCompleted: Object.values(maint.services).flat().filter(r => Date.parse(r.servicedAt) > weekAgo).length,
        garageVisits:      Object.values(maint.visits).flat().filter(r => Date.parse(r.enteredAt) > weekAgo).length,
      },
    },
  }
  return { facts, activeCount, totalCount }
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * What the brief is FOR.
 *
 * The manager reading this card is standing in a live shift, not reviewing a
 * quarter. The prompt this replaced asked for "overall fleet health, the most
 * significant data trend, and a recommended action" over 30-day aggregates, and
 * it produced exactly what it asked for: fluent, unfalsifiable executive prose
 * ("fleet health is stable; consider tightening driver monitoring") that told
 * the operator nothing they could act on before lunch.
 *
 * The answer to that was NOT more material. A first pass let the model spend a
 * 70-word budget across the day, the aggregates and an action, and it filled
 * the space — driver ratings, busiest depots, 30-day tonnage — which is the
 * same fault wearing better numbers. The fleet manager's own words for it were
 * "it's too much".
 *
 * So the brief is now three sentences and a hard list of what may appear in
 * them: fleet health, this morning's gate movement split by destination, and
 * today's fuel exceptions with the number that actually needs chasing.
 * Everything else in the payload exists ONLY to inform the risk verdict. The
 * model chooses the wording; it never chooses the content.
 *
 * The unit counts are NOT among them. FleetAIInsightCard prints "115/510
 * active:" immediately before this text, so a sentence that also says "115 out
 * of 510 units active" stutters on the card. The ratio still sets the health
 * verdict — it is simply the card's job to print it, not the model's.
 */
export const SYSTEM_PROMPT =
  'You are the duty operations analyst for a Kenyan haulage fleet, briefing the fleet manager mid-shift. ' +
  'You receive a JSON object of MEASURED facts. Write EXACTLY THREE short sentences, at most 60 words in total, ' +
  'and nothing else: ' +
  '(1) Fleet health and your risk verdict — e.g. "Fleet health is good, though risk is high." Do NOT state the ' +
  'active or total unit counts: the card prints "115/510 active:" immediately before your text, so repeating them ' +
  'reads as a stutter. Let that ratio inform the verdict without naming it. ' +
  '(2) Today\'s gate movement broken down by destination, from `today.leftGate`, `today.sinceLabel` (use it ' +
  'verbatim) and `today.byDestination` — e.g. "We have had 70 units leave the gate this morning, with 20 going to ' +
  'WEIGHBRIDGE X and 50 going to WEIGHBRIDGE Y." ' +
  '(3) Today\'s fuel exceptions, from `today.fuelIssues.raised` and `today.fuelIssues.needInvestigating` — e.g. ' +
  '"There are 19 fuel issues raised, 5 of which need investigating." ' +
  'NOTHING ELSE BELONGS IN THE BRIEF. Do not mention 30-day trends, tonnage, deliveries, timeliness, drivers, ' +
  'ratings, conduct cases, depots, products, maintenance, services or garage visits: those figures are in the ' +
  'payload ONLY to inform your risk verdict, and naming any of them in the text is a failure. Do not add a ' +
  'recommendation, an action, or a closing remark. Three sentences, then stop. ' +
  'THE NUMBERS ARE THE POINT. Quote them exactly as given; never estimate, re-derive, round differently or invent ' +
  'one. `leftGate` is units SEEN clearing the barrier and is the figure sentence 2 reports — never substitute ' +
  '`dispatchesRaised`, which is only the paperwork. `raised` fuel issues are not all actionable: only ' +
  '`needInvestigating` are confirmed losses, and sentence 3 must keep the two apart. Name destinations EXACTLY as ' +
  'spelled in the JSON. ' +
  'WRITE PROSE, NOT A FIELD DUMP. Never print a JSON key — not "leftGate", "needInvestigating", "dispatchesRaised" ' +
  'nor any other — and never use the "label: value" form. Begin with a capital letter and write complete sentences. ' +
  'Agree singular and plural with the actual figure — "There is 1 fuel issue raised", never "There are 1 fuel ' +
  'issues" — and write "none of which" rather than "0 of which". Write the risk level in lower case inside the ' +
  'sentence ("risk is medium"), since it is prose and not a label. ' +
  'DO NOT NARRATE ZEROES. The fleet day begins at local midnight, so early in it there is genuinely nothing to ' +
  'report. If `today.quiet` is true or `today.leftGate` is 0, sentence 2 becomes exactly "Nothing has been ' +
  'dispatched yet today." If `today.fuelIssues.raised` is 0, sentence 3 becomes exactly "No fuel issues have been ' +
  'raised today." Never list zero figures one after another, and never write "unknown", "no data", "not reported" ' +
  'or "none listed". ' +
  'No markdown, no preamble, no bullet points, no hedging. ' +
  'Classify overall operational risk with this rubric — the level MUST match the tone of your msg: ' +
  '"Low" = broadly positive (good timeliness, stable or improving trends, few conduct cases/incidents, few confirmed fuel losses); ' +
  '"Medium" = notable but contained issues or mixed trends; ' +
  '"High" = ONLY for serious, systemic problems (timeliness under ~50%, sharply worsening incidents, repeated confirmed ' +
  'fuel losses, or a large share of the fleet down). ' +
  'Never pair a positive summary with High risk, and never call risk High off `raised` fuel issues that have not been ' +
  'confirmed as losses. Reply with STRICT JSON: {"msg": string, "risk": "Low"|"Medium"|"High"}.'

async function generateFor(orgId: string): Promise<void> {
  if (generating.has(orgId)) return
  generating.add(orgId)
  try {
    const { facts, activeCount, totalCount } = await collectFacts(orgId)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(facts) },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body   = await res.json() as { choices?: { message?: { content?: string } }[] }
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { msg?: string; risk?: string }
    if (!parsed.msg) throw new Error('empty insight from model')

    const risk = (['Low', 'Medium', 'High'] as const).find(r => r === parsed.risk) ?? 'Medium'
    insights.set(orgId, {
      configured: true,
      insight: { msg: parsed.msg, risk, activeCount, totalCount, generatedAt: new Date().toISOString() },
    })
    logger.info({ orgId, risk }, 'AI insight refreshed')
  } catch (err) {
    logger.warn({ err, orgId }, 'AI insight generation failed — previous brief (or local fallback) stays')
  } finally {
    generating.delete(orgId)
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/** Instant, in-memory read. A cold miss triggers background generation and
 *  returns insight:null so clients render their local fallback meanwhile. */
export async function getAiInsight(orgId: string): Promise<AiInsightResponse> {
  if (!env.OPENAI_API_KEY) return { configured: false, insight: null }
  const hit = insights.get(orgId)
  if (hit) return hit
  void generateFor(orgId)
  return { configured: true, insight: null }
}

/** Hourly regeneration for every org — started from index.ts. */
export function startAiInsightWarmer(): () => void {
  if (!env.OPENAI_API_KEY) return () => {}
  let stopped = false
  const sweep = async () => {
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true } })
      for (const org of orgs) {
        if (stopped) return
        await generateFor(org.id)
      }
    } catch (err) {
      logger.warn({ err }, 'AI insight sweep failed')
    }
  }
  void sweep()
  const timer = setInterval(() => void sweep(), REFRESH_MS)
  return () => { stopped = true; clearInterval(timer) }
}
