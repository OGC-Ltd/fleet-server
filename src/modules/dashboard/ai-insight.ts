// Fleet AI Insight — an hourly executive brief written by OpenAI (gpt-5-nano
// acting as the fleet's senior data analyst) over the SAME aggregates the
// Analytics, Drivers and Maintenance pages render.
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

async function collectFacts(orgId: string) {
  const [snapshot, drivers, deliveries, history, maint] = await Promise.all([
    getFleetSnapshotCached(orgId),
    getDriversOverview(orgId, DEFAULT_DRIVER_WINDOW_DAYS),
    getDeliveriesAnalytics(orgId, 30),
    getMaintenanceHistoryCached(orgId, DEFAULT_HISTORY_WINDOW_DAYS),
    getOrgVehicleMaintenance(orgId),
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

const SYSTEM_PROMPT =
  'You are the senior data analyst for a Kenyan haulage fleet. You receive a JSON snapshot ' +
  'aggregated from the fleet\'s three dashboards: Drivers (ratings, conduct cases, top performers), ' +
  'Analytics (30-day delivery volumes, trends, timeliness) and Maintenance (incidents, services, garage visits), ' +
  'plus the live fleet state. Write an optimised executive insight for the fleet manager: AT MOST 50 words, 2-3 short sentences. ' +
  'Lead with overall fleet health, then the most significant data trend citing concrete numbers from the snapshot, ' +
  'then the single highest-impact recommended action. No markdown, no preamble, no hedging. ' +
  'Classify overall operational risk with this rubric — the level MUST match the tone of your msg: ' +
  '"Low" = data is broadly positive (good timeliness, stable or improving trends, few conduct cases/incidents); ' +
  '"Medium" = notable but contained issues or mixed trends; ' +
  '"High" = ONLY for serious, systemic problems (timeliness under ~50%, sharply worsening incidents, repeated fuel theft, or a large share of the fleet down). ' +
  'Never pair a positive summary with High risk. Reply with STRICT JSON: {"msg": string, "risk": "Low"|"Medium"|"High"}.'

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
