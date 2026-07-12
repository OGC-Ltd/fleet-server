// Data assembly for the downloadable PDF reports (report-pdf.renderer.ts
// draws them). One collector per report kind — Analytics, Drivers,
// Maintenance — each reading the SAME warmed aggregates its dashboard page
// renders, so the report always matches what's on screen. The "what stands
// out" band is heuristic (deterministic, instant, works offline) — it cites
// concrete numbers the way the template does.

import { prisma } from '../../lib/prisma.js'
import { getDeliveriesAnalytics } from '../analytics/deliveries.cache.js'
import { getDriversOverview } from '../analytics/drivers-overview.cache.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance } from '../telemetry/maintenance.cache.js'
import { renderReportPdf, type ReportData, type ReportBarRow, type ReportInsight } from './report-pdf.renderer.js'

export const PDF_REPORT_KINDS = ['analytics', 'drivers', 'maintenance'] as const
export type PdfReportKind = (typeof PDF_REPORT_KINDS)[number]

// Fuel-cost model — mirrors fleettrack's AnalyticsScreen constants exactly so
// the PDF and the page never disagree.
const FUEL_RATES_KES = { diesel: 179.36, petrol: 189.84 }
const LITRES_PER_100KM = 35

// Same wear catalog the Maintenance pages grade with (fleettrack
// lib/maintenanceSchedule.js / fleetdash equivalent).
const MAINTENANCE_CATALOG: [string, number][] = [
  ['Engine Oil & Filter', 5_000], ['Tyre Rotation', 8_000], ['Tyre Tread & Pressure', 10_000],
  ['Engine Air Filter', 15_000], ['Cabin/Pollen Filter', 15_000], ['Wheel Alignment & Suspension', 15_000],
  ['Battery & Terminals', 20_000], ['Wiper Blades & Lights', 20_000], ['Brake Pads & Rotors', 20_000],
  ['Brake Fluid', 40_000], ['Coolant (Antifreeze)', 60_000], ['Transmission Fluid', 60_000],
  ['Belts & Hoses', 80_000],
]

const REGION_BY_CODE: Record<string, string> = {
  SUKARI: 'South Nyanza · Kenya',
  AQUAMIST: 'Nairobi · Kenya',
  MENENGAI: 'Central Rift · Kenya',
  TIMSALES: 'Rift Valley · Kenya',
  KABRAS: 'Western · Kenya',
}

const fmt = (n: number, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

const fmtDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-KE', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export async function generateReportPdf(orgId: string, kind: PdfReportKind, days: number):
  Promise<{ buffer: Buffer; filename: string }> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } })
  const orgName = org?.name ?? 'Fleet'
  const orgRegion = REGION_BY_CODE[org?.code ?? ''] ?? 'Kenya'
  const short = (org?.code ?? 'fleet').charAt(0) + (org?.code ?? 'fleet').slice(1).toLowerCase()

  const data =
    kind === 'analytics' ? await collectAnalytics(orgId, days) :
    kind === 'drivers' ? await collectDrivers(orgId, days) :
    await collectMaintenance(orgId, days)

  data.orgName = orgName
  data.orgRegion = orgRegion
  const buffer = await renderReportPdf(data)
  const kindName = kind.charAt(0).toUpperCase() + kind.slice(1)
  return { buffer, filename: `${short}-${kindName}-Report.pdf` }
}

// ── Analytics ────────────────────────────────────────────────────────────────

async function collectAnalytics(orgId: string, days: number): Promise<ReportData> {
  return buildAnalyticsReport(await getDeliveriesAnalytics(orgId, days), days)
}

/** Pure — takes the deliveries aggregate, returns the drawable report. */
export function buildAnalyticsReport(a: DeliveriesPayload, days: number): ReportData {
  const { totals, deliveries, distance, byDay } = a
  const timelyPct = deliveries.total > 0 ? Math.round((deliveries.timely / deliveries.total) * 100) : 0

  const totalLitres = (distance.totalKm * LITRES_PER_100KM) / 100
  const perDayLitres = (distance.perDayKm * LITRES_PER_100KM) / 100

  const maxProduct = Math.max(1, ...a.products.map(p => p.tonnes))
  const productRows: ReportBarRow[] = a.products.slice(0, 10).map(p => {
    const [name, ...spec] = p.product.split(' — ')
    return {
      label: name!, note: spec.join(' — ') || undefined,
      value: fmt(p.tonnes, 1), valueNote: `t · ${p.trips}`,
      frac: p.tonnes / maxProduct,
    }
  })

  const maxDepot = Math.max(1, ...a.depots.map(d => d.tonnes))
  const depotRows: ReportBarRow[] = a.depots.map(d => ({
    label: d.depot, value: fmt(d.tonnes, 1), valueNote: `t · ${d.trips}`, frac: d.tonnes / maxDepot,
  }))

  const maxTonnes = Math.max(1, ...byDay.map(d => d.tonnes))

  return {
    title: 'Fleet Analytics Report',
    orgName: '', orgRegion: '', // filled by generateReportPdf
    windowLabel: `Trailing ${days} days`,
    kpis: [
      { label: 'Deliveries', value: fmt(totals.trips), sub: `completed across ${totals.activeDays} active days` },
      { label: 'Goods ferried', value: fmt(totals.tonnes), unit: 't', sub: `across ${a.products.length} product lines` },
      { label: 'Distance covered', value: fmt(totals.distanceKm), unit: 'km', sub: `${fmt(distance.perDayKm)} km per day on average` },
      { label: 'Timely deliveries', value: `${timelyPct}%`, sub: `${fmt(deliveries.timely)} of ${fmt(deliveries.total)} arrived on time`, dark: true },
    ],
    bars: { title: 'Products', note: 'tonnes · trips', rows: productRows },
    donut: {
      title: 'Delivery reliability', note: 'Timely vs interrupted',
      data: {
        centerValue: `${timelyPct}%`, centerLabel: 'on time',
        segments: [
          { label: 'Timely', value: `${fmt(deliveries.timely)} · ${timelyPct}%`, frac: deliveries.total ? deliveries.timely / deliveries.total : 0, color: '#1e6f4e' },
          { label: 'Interrupted', value: `${fmt(deliveries.interrupted)} · ${100 - timelyPct}%`, frac: deliveries.total ? deliveries.interrupted / deliveries.total : 0, color: '#cf4a3d' },
        ],
      },
    },
    ranked: { title: 'Depots served', titleNote: '— most to least', note: `${a.depots.length} destinations`, rows: depotRows },
    panels: [
      {
        title: 'Fuel cost estimate',
        bigs: [
          { value: fmt(totalLitres), unit: 'L', caption: 'estimated total' },
          { value: fmt(perDayLitres), unit: 'L', caption: 'per day' },
        ],
        rows: [
          { label: 'Diesel cost estimate', value: `KES ${fmt(totalLitres * FUEL_RATES_KES.diesel)}` },
          { label: 'Petrol cost estimate', value: `KES ${fmt(totalLitres * FUEL_RATES_KES.petrol)}` },
        ],
      },
      {
        title: 'Distance covered — averages', underline: true,
        bigs: [
          { value: fmt(distance.totalKm), caption: 'Total km' },
          { value: fmt(distance.perDayKm), caption: 'Per day' },
          { value: fmt(distance.perWeekKm), caption: 'Per week' },
          { value: fmt(distance.perMonthKm), caption: 'Per month (proj.)' },
        ],
      },
    ],
    daily: {
      title: 'Daily activity',
      legend: [
        { label: 'Tonnes ferried', color: '#1e6f4e' },
        { label: 'day with interruptions', color: '#cf4a3d' },
      ],
      bars: byDay.map(d => ({ frac: d.tonnes / maxTonnes, alert: d.timely < d.trips })),
    },
    insights: analyticsInsights(a),
    table: {
      title: 'Daily activity log', note: `${totals.activeDays} active days`,
      columns: [
        { label: 'Date', width: 0.16 }, { label: 'Trips', width: 0.14, align: 'right' },
        { label: 'Tonnes', width: 0.17, align: 'right' }, { label: 'Distance', width: 0.18, align: 'right' },
        { label: 'Timely', width: 0.15, align: 'right' }, { label: 'Reliability', width: 0.2, align: 'right' },
      ],
      rows: byDay.map(d => {
        const rel = d.trips > 0 ? Math.round((d.timely / d.trips) * 100) : 100
        return {
          cells: [fmtDay(d.day), fmt(d.trips), fmt(d.tonnes, 1), fmt(d.distanceKm), fmt(d.timely), `${rel}%`],
          alert: rel < 100,
          lastCellColor: (rel < 100 ? 'bad' : 'good') as 'bad' | 'good',
        }
      }),
    },
  }
}

type DeliveriesPayload = Awaited<ReturnType<typeof getDeliveriesAnalytics>>

function analyticsInsights(a: DeliveriesPayload): ReportInsight[] {
  const { byDay, deliveries, totals } = a
  const out: ReportInsight[] = []

  const sorted = [...byDay].sort((x, y) => y.trips - x.trips)
  const top3 = sorted.slice(0, 3)
  const top3Trips = top3.reduce((s, d) => s + d.trips, 0)
  const share = totals.trips ? Math.round((top3Trips / totals.trips) * 100) : 0
  if (share >= 50 && top3.length === 3) {
    out.push({
      title: 'Spiky volume',
      body: `Three days — ${top3.map(d => fmtDay(d.day)).join(', ')} — carry ${share}% of trips. The fleet runs light most days, then surges past ${fmt(sorted[0]!.trips)} deliveries. Scheduling smoothing could cut peak strain.`,
    })
  } else {
    out.push({
      title: 'Steady cadence',
      body: `Volume is spread across ${totals.activeDays} active days, averaging ${fmt(totals.trips / Math.max(1, totals.activeDays), 1)} trips a day with ${fmtDay(sorted[0]?.day ?? byDay[0]!.day)} the busiest at ${fmt(sorted[0]?.trips ?? 0)}.`,
    })
  }

  const interruptedDays = byDay.filter(d => d.timely < d.trips)
  const quartile = Math.max(1, Math.ceil(byDay.length / 4))
  const busiest = new Set(sorted.slice(0, quartile).map(d => d.day))
  const onBusy = interruptedDays.filter(d => busiest.has(d.day)).length
  if (deliveries.interrupted > 0) {
    out.push({
      title: 'Load-driven delays',
      body: onBusy === interruptedDays.length
        ? `All ${fmt(deliveries.interrupted)} interruptions fell on the ${interruptedDays.length} highest-volume days. Reliability drops under load, not at random — surge capacity is the lever, not route quality.`
        : `${fmt(deliveries.interrupted)} interruptions across ${interruptedDays.length} days, ${onBusy} of them on peak-volume days. Timeliness holds at ${Math.round((deliveries.timely / Math.max(1, deliveries.total)) * 100)}% overall.`,
    })
  } else {
    out.push({
      title: 'Clean record',
      body: `Every one of the ${fmt(deliveries.total)} deliveries in this window arrived on time — no interruptions recorded.`,
    })
  }

  const top = a.products[0]
  const unspec = a.products.find(p => /unspecified|unclassified/i.test(p.product))
  const family = (top?.product ?? '').split(' — ')[0]
  out.push({
    title: family ? `${family} leads the mix` : 'Product mix',
    body: `${family || 'The top line'} dominates tonnage at ${fmt(top?.tonnes ?? 0, 1)} t, and ${a.depots[0]?.depot ?? 'the lead depot'} is the heaviest destination.${unspec && unspec.trips > 0 ? ` ${fmt(unspec.trips)} trips remain unclassified — tightening capture would sharpen this view.` : ''}`,
  })
  return out
}

// ── Drivers ──────────────────────────────────────────────────────────────────

async function collectDrivers(orgId: string, days: number): Promise<ReportData> {
  return buildDriversReport(await getDriversOverview(orgId, days), days)
}

/** Pure — takes the drivers overview, returns the drawable report. */
export function buildDriversReport(overview: Awaited<ReturnType<typeof getDriversOverview>>, days: number): ReportData {
  const roster = overview.drivers
  const trips = roster.reduce((s, d) => s + d.trips, 0)
  const tonnes = roster.reduce((s, d) => s + d.tonnes, 0)
  const mileage = roster.reduce((s, d) => s + (d.mileageKm ?? 0), 0)
  const overspeed = roster.reduce((s, d) => s + d.overspeedingCases, 0)
  const theft = roster.reduce((s, d) => s + d.fuelTheftCases, 0)
  const avgRating = roster.length ? roster.reduce((s, d) => s + d.rating, 0) / roster.length : 0
  const clean = roster.filter(d => d.overspeedingCases === 0 && d.fuelTheftCases === 0)
  const cleanPct = roster.length ? Math.round((clean.length / roster.length) * 100) : 0

  const byTonnes = [...roster].sort((a, b) => b.tonnes - a.tonnes)
  const maxTonnes = Math.max(1, byTonnes[0]?.tonnes ?? 1)
  const offenders = [...roster].filter(d => d.overspeedingCases + d.fuelTheftCases > 0)
    .sort((a, b) => (b.overspeedingCases + b.fuelTheftCases) - (a.overspeedingCases + a.fuelTheftCases))
  const maxCases = Math.max(1, ...offenders.map(d => d.overspeedingCases + d.fuelTheftCases))
  const maxRosterTrips = Math.max(1, ...roster.map(d => d.trips))

  return {
    title: 'Fleet Drivers Report',
    orgName: '', orgRegion: '',
    windowLabel: `Trailing ${days} days`,
    kpis: [
      { label: 'Drivers', value: fmt(roster.length), sub: `active roster, ${fmt(trips)} trips completed` },
      { label: 'Goods ferried', value: fmt(tonnes), unit: 't', sub: `${fmt(mileage)} km driven across the roster` },
      { label: 'Conduct cases', value: fmt(overspeed + theft), sub: `${fmt(overspeed)} overspeeding · ${fmt(theft)} fuel theft` },
      { label: 'Fleet avg rating', value: avgRating.toFixed(2), unit: '/5', sub: (n => `${n} driver${n === 1 ? '' : 's'} rated below 4.0`)(roster.filter(d => d.rating < 4).length), dark: true },
    ],
    bars: {
      title: 'Top drivers', note: 'tonnes · trips',
      rows: byTonnes.slice(0, 10).map(d => ({
        // Helvetica has no star glyph — spell the rating out.
        label: d.fullName, note: `rated ${d.rating.toFixed(2)}`,
        value: fmt(d.tonnes, 1), valueNote: `t · ${d.trips}`,
        frac: d.tonnes / maxTonnes,
      })),
    },
    donut: {
      title: 'Conduct', note: 'Clean records vs flagged drivers',
      data: {
        centerValue: `${cleanPct}%`, centerLabel: 'clean',
        segments: [
          { label: 'Clean record', value: `${clean.length} · ${cleanPct}%`, frac: roster.length ? clean.length / roster.length : 0, color: '#1e6f4e' },
          { label: 'Flagged', value: `${roster.length - clean.length} · ${100 - cleanPct}%`, frac: roster.length ? (roster.length - clean.length) / roster.length : 0, color: '#cf4a3d' },
        ],
      },
    },
    ranked: offenders.length > 0 ? {
      title: 'Conduct cases', titleNote: '— most to least', note: `${offenders.length} drivers flagged`,
      rows: offenders.map(d => ({
        label: d.fullName,
        value: fmt(d.overspeedingCases + d.fuelTheftCases),
        valueNote: d.fuelTheftCases > 0 ? `· ${d.fuelTheftCases} theft` : 'cases',
        frac: (d.overspeedingCases + d.fuelTheftCases) / maxCases,
      })),
    } : undefined,
    panels: [
      {
        title: 'Workload',
        bigs: [
          { value: fmt(trips), caption: 'trips completed' },
          { value: fmt(trips / Math.max(1, roster.length), 1), caption: 'trips per driver' },
        ],
        rows: [
          { label: 'Tonnes per driver (avg)', value: `${fmt(tonnes / Math.max(1, roster.length), 1)} t` },
          { label: 'Distance per driver (avg)', value: `${fmt(mileage / Math.max(1, roster.length))} km` },
        ],
      },
      {
        title: 'Ratings — distribution', underline: true,
        bigs: [
          { value: fmt(roster.filter(d => d.rating >= 4.8).length), caption: '4.8 and above' },
          { value: fmt(roster.filter(d => d.rating >= 4 && d.rating < 4.8).length), caption: '4.0 – 4.8' },
          { value: fmt(roster.filter(d => d.rating < 4).length), caption: 'Below 4.0' },
          { value: byTonnes[0] ? byTonnes[0].fullName.split(' ')[0]! : '—', caption: 'top performer' },
        ],
      },
    ],
    daily: {
      title: 'Trips by driver',
      legend: [
        { label: 'Trips in window', color: '#1e6f4e' },
        { label: 'driver with fuel-theft case', color: '#cf4a3d' },
      ],
      bars: byTonnes.map(d => ({ frac: d.trips / maxRosterTrips, alert: d.fuelTheftCases > 0 })),
    },
    insights: driverInsights(roster, tonnes, overspeed, theft, avgRating),
    table: {
      title: 'Driver roster', note: `${roster.length} drivers`,
      columns: [
        { label: 'Driver', width: 0.26 }, { label: 'Trips', width: 0.11, align: 'right' },
        { label: 'Tonnes', width: 0.14, align: 'right' }, { label: 'Distance', width: 0.16, align: 'right' },
        { label: 'Cases', width: 0.13, align: 'right' }, { label: 'Rating', width: 0.2, align: 'right' },
      ],
      rows: byTonnes.map(d => ({
        cells: [d.fullName, fmt(d.trips), fmt(d.tonnes, 1), `${fmt(d.mileageKm ?? 0)} km`,
          fmt(d.overspeedingCases + d.fuelTheftCases), d.rating.toFixed(2)],
        alert: d.fuelTheftCases > 0 || d.rating < 4,
        lastCellColor: (d.rating < 4 ? 'bad' : 'good') as 'bad' | 'good',
      })),
    },
  }
}

type Roster = Awaited<ReturnType<typeof getDriversOverview>>['drivers']

function driverInsights(roster: Roster, tonnes: number, overspeed: number, theft: number, avgRating: number): ReportInsight[] {
  const byTonnes = [...roster].sort((a, b) => b.tonnes - a.tonnes)
  const top3 = byTonnes.slice(0, 3)
  const share = tonnes ? Math.round((top3.reduce((s, d) => s + d.tonnes, 0) / tonnes) * 100) : 0
  const worst = [...roster].sort((a, b) => b.overspeedingCases - a.overspeedingCases)[0]
  const below4 = roster.filter(d => d.rating < 4)
  return [
    {
      title: 'Tonnage concentration',
      body: `${top3.map(d => d.fullName.split(' ')[0]).join(', ')} haul ${share}% of all tonnage. ${top3[0]?.fullName ?? '—'} leads with ${fmt(top3[0]?.tonnes ?? 0, 1)} t over ${fmt(top3[0]?.trips ?? 0)} trips.`,
    },
    {
      title: overspeed + theft > 0 ? 'Conduct hotspots' : 'Clean conduct',
      body: overspeed + theft > 0
        ? `${fmt(overspeed)} overspeeding and ${fmt(theft)} fuel-theft cases in the window. ${worst?.fullName ?? '—'} alone accounts for ${fmt(worst?.overspeedingCases ?? 0)} overspeeding cases — a targeted coaching candidate.`
        : `No overspeeding or fuel-theft cases were recorded across the roster in this window.`,
    },
    {
      title: 'Ratings picture',
      body: below4.length > 0
        ? `The fleet averages ${avgRating.toFixed(2)}/5, but ${below4.length} driver${below4.length === 1 ? ' sits' : 's sit'} below 4.0 (${below4.slice(0, 2).map(d => d.fullName.split(' ')[0]).join(', ')}${below4.length > 2 ? '…' : ''}). Ratings recover fastest when conduct cases stop.`
        : `The fleet averages ${avgRating.toFixed(2)}/5 with every driver at 4.0 or better — conduct and ratings are aligned.`,
    },
  ]
}

// ── Maintenance ──────────────────────────────────────────────────────────────

interface VehicleGrade {
  plate: string; vehicleType: string; odometerKm: number | null
  label: 'Overdue' | 'Due Soon' | 'Monitor' | 'Good' | 'In Service' | 'No data'
  worstItem: string | null; kmRemaining: number | null; healthPct: number | null
}

function gradeVehicle(v: { plate: string; vehicleType: string; odometerKm?: number | null; maintenanceResetOdoKm?: number | null; inMaintenance?: boolean }): VehicleGrade {
  const base = { plate: v.plate, vehicleType: v.vehicleType, odometerKm: v.odometerKm ?? null }
  if (v.inMaintenance) return { ...base, label: 'In Service', worstItem: null, kmRemaining: null, healthPct: null }
  if (v.odometerKm == null) return { ...base, label: 'No data', worstItem: null, kmRemaining: null, healthPct: null }
  const reset = v.maintenanceResetOdoKm ?? 0
  let worst: { name: string; kmRemaining: number; pct: number } | null = null
  for (const [name, interval] of MAINTENANCE_CATALOG) {
    const into = (((v.odometerKm - reset) % interval) + interval) % interval
    const kmRemaining = interval - into
    const pct = (kmRemaining / interval) * 100
    if (!worst || pct < worst.pct) worst = { name, kmRemaining, pct }
  }
  const label = worst!.pct > 70 ? 'Good' : worst!.pct > 40 ? 'Monitor' : worst!.pct > 15 ? 'Due Soon' : 'Overdue'
  return { ...base, label, worstItem: worst!.name, kmRemaining: Math.round(worst!.kmRemaining), healthPct: Math.round(worst!.pct) }
}

async function collectMaintenance(orgId: string, days: number): Promise<ReportData> {
  const [snapshot, history, maint] = await Promise.all([
    getFleetSnapshotCached(orgId),
    getMaintenanceHistoryCached(orgId, days),
    getOrgVehicleMaintenance(orgId),
  ])
  return buildMaintenanceReport(snapshot, history, maint, days)
}

/** Pure — takes snapshot + history + workshop records, returns the drawable report. */
export function buildMaintenanceReport(
  snapshot: Awaited<ReturnType<typeof getFleetSnapshotCached>>,
  history: HistoryRows,
  maint: Awaited<ReturnType<typeof getOrgVehicleMaintenance>>,
  days: number,
): ReportData {
  const grades = snapshot.map(v => gradeVehicle(v as Parameters<typeof gradeVehicle>[0]))
  const count = (l: VehicleGrade['label']) => grades.filter(g => g.label === l).length
  const attention = count('Overdue') + count('Due Soon') + count('In Service')
  const healthy = grades.length - attention
  const healthyPct = grades.length ? Math.round((healthy / grades.length) * 100) : 0

  const distanceKm = history.reduce((s, h) => s + h.distanceKm, 0)
  const fuelL = history.reduce((s, h) => s + h.fuelConsumedL, 0)
  const overspeeding = history.reduce((s, h) => s + h.overspeedingCount, 0)
  const fuelIncidents = history.reduce((s, h) => s + h.fuelInconsistencyCount, 0)
  const services = Object.values(maint.services).flat().length
  const visits = Object.values(maint.visits).flat().length

  // Vehicles nearest their next service, most urgent first.
  const nearest = grades.filter(g => g.kmRemaining != null)
    .sort((a, b) => (a.kmRemaining ?? 0) - (b.kmRemaining ?? 0))

  const maxKm = Math.max(1, ...history.map(h => h.distanceKm))

  const rankRows: ReportBarRow[] = nearest.slice(0, 14).map(g => ({
    label: g.plate,
    value: fmt(g.kmRemaining ?? 0), valueNote: `km · ${g.worstItem?.split(' ')[0] ?? ''}`,
    frac: 1 - Math.min(1, (g.healthPct ?? 100) / 100),
  }))

  const statusOrder: VehicleGrade['label'][] = ['Overdue', 'Due Soon', 'In Service', 'Monitor', 'Good']
  const badge: Record<string, 'bad' | 'good'> = { Overdue: 'bad', 'Due Soon': 'bad', 'In Service': 'bad' }

  return {
    title: 'Fleet Maintenance Report',
    orgName: '', orgRegion: '',
    windowLabel: `Trailing ${days} days`,
    kpis: [
      { label: 'Fleet size', value: fmt(grades.length), sub: `${fmt(distanceKm)} km covered in the window` },
      { label: 'Needs attention', value: fmt(attention), sub: `${count('Overdue')} overdue · ${count('Due Soon')} due soon · ${count('In Service')} in service` },
      { label: 'Incidents', value: fmt(overspeeding + fuelIncidents), sub: `${fmt(overspeeding)} overspeeding · ${fmt(fuelIncidents)} fuel inconsistency` },
      { label: 'Fleet health', value: `${healthyPct}%`, sub: `${fmt(healthy)} of ${fmt(grades.length)} vehicles in good shape`, dark: true },
    ],
    bars: {
      title: 'Wear leaders', note: 'health remaining',
      rows: nearest.slice(0, 10).map(g => ({
        label: g.plate, note: g.worstItem ?? undefined,
        value: `${g.healthPct ?? 0}%`, valueNote: `· ${fmt(g.kmRemaining ?? 0)} km left`,
        frac: (g.healthPct ?? 0) / 100,
      })),
    },
    donut: {
      title: 'Fleet health', note: 'Good & monitor vs needing attention',
      data: {
        centerValue: `${healthyPct}%`, centerLabel: 'healthy',
        segments: [
          { label: 'Good / Monitor', value: `${fmt(healthy)} · ${healthyPct}%`, frac: grades.length ? healthy / grades.length : 0, color: '#1e6f4e' },
          { label: 'Needs attention', value: `${fmt(attention)} · ${100 - healthyPct}%`, frac: grades.length ? attention / grades.length : 0, color: '#cf4a3d' },
        ],
      },
    },
    ranked: { title: 'Next services', titleNote: '— most urgent first', note: `${nearest.length} vehicles tracked`, rows: rankRows },
    panels: [
      {
        title: 'Fuel consumed',
        bigs: [
          { value: fmt(fuelL), unit: 'L', caption: `across ${days} days` },
          { value: fmt(fuelL / Math.max(1, history.filter(h => h.distanceKm > 0).length)), unit: 'L', caption: 'per active day' },
        ],
        rows: [
          { label: 'Diesel cost estimate', value: `KES ${fmt(fuelL * FUEL_RATES_KES.diesel)}` },
          { label: 'Real consumption', value: `${distanceKm > 0 ? fmt((fuelL / distanceKm) * 100, 1) : '—'} L / 100 km` },
        ],
      },
      {
        title: 'Workshop — last window', underline: true,
        bigs: [
          { value: fmt(services), caption: 'services completed' },
          { value: fmt(visits), caption: 'garage visits' },
          { value: fmt(overspeeding), caption: 'overspeeding incidents' },
          { value: fmt(fuelIncidents), caption: 'fuel inconsistencies' },
        ],
      },
    ],
    daily: {
      title: 'Daily distance & incidents',
      legend: [
        { label: 'Distance driven', color: '#1e6f4e' },
        { label: 'day with incidents', color: '#cf4a3d' },
      ],
      bars: history.map(h => ({
        frac: h.distanceKm / maxKm,
        alert: h.overspeedingCount + h.fuelInconsistencyCount > 0 && h.distanceKm > 0,
      })),
    },
    insights: maintenanceInsights(grades, nearest, history, distanceKm, fuelL),
    table: {
      title: 'Fleet service sheet', note: `${grades.length} vehicles`,
      columns: [
        { label: 'Vehicle', width: 0.16 }, { label: 'Type', width: 0.14 },
        { label: 'Odometer', width: 0.18, align: 'right' }, { label: 'Worst item', width: 0.24 },
        { label: 'Km to service', width: 0.14, align: 'right' }, { label: 'Status', width: 0.14, align: 'right' },
      ],
      rows: [...grades]
        .sort((a, b) => statusOrder.indexOf(a.label) - statusOrder.indexOf(b.label))
        .map(g => ({
          cells: [g.plate, g.vehicleType, g.odometerKm != null ? `${fmt(g.odometerKm)} km` : '—',
            g.worstItem ?? '—', g.kmRemaining != null ? fmt(g.kmRemaining) : '—', g.label],
          alert: !!badge[g.label],
          lastCellColor: (badge[g.label] ?? 'good') as 'bad' | 'good',
        })),
    },
  }
}

type HistoryRows = Awaited<ReturnType<typeof getMaintenanceHistoryCached>>

function maintenanceInsights(grades: VehicleGrade[], nearest: VehicleGrade[], history: HistoryRows, distanceKm: number, fuelL: number): ReportInsight[] {
  const half = Math.max(1, Math.floor(history.length / 2))
  const incidents = (rows: HistoryRows) => rows.reduce((s, h) => s + h.overspeedingCount + h.fuelInconsistencyCount, 0)
  const cur = incidents(history.slice(-half))
  const prev = incidents(history.slice(-2 * half, -half))
  const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null
  const urgent = nearest[0]
  const attention = grades.filter(g => g.label === 'Overdue' || g.label === 'Due Soon' || g.label === 'In Service')
  const lPer100 = distanceKm > 0 ? (fuelL / distanceKm) * 100 : 0

  return [
    {
      title: attention.length > 0 ? 'Service queue forming' : 'Healthy fleet',
      body: attention.length > 0
        ? `${attention.length} vehicle${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention. ${urgent?.plate ?? '—'} is nearest the wall — ${fmt(urgent?.kmRemaining ?? 0)} km from its ${urgent?.worstItem ?? 'next service'}. Book it before the interval lapses.`
        : `Every vehicle grades Good or Monitor. ${urgent?.plate ?? '—'} is next in line at ${fmt(urgent?.kmRemaining ?? 0)} km from its ${urgent?.worstItem ?? 'next service'} — nothing urgent.`,
    },
    {
      title: delta != null && delta > 25 ? 'Incidents climbing' : delta != null && delta < -25 ? 'Incidents easing' : 'Incident trend',
      body: delta != null
        ? `Incidents moved ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)}% half-over-half (${fmt(prev)} → ${fmt(cur)}). ${delta > 25 ? 'Overspeeding drives most of it — pair the worst routes with coaching.' : delta < -25 ? 'The trend is going the right way — keep the current controls in place.' : 'The level is stable across the window.'}`
        : `${fmt(cur)} incidents in the recent half-window with no prior baseline to compare against yet.`,
    },
    {
      title: 'Fuel burn',
      body: lPer100 > 0
        ? `The fleet is burning ${fmt(lPer100, 1)} L/100 km against the ${LITRES_PER_100KM} L planning baseline${lPer100 > LITRES_PER_100KM ? ' — heavy loads or idling are costing extra litres' : ' — running leaner than budgeted'}. ${fmt(fuelL)} L consumed over ${fmt(distanceKm)} km.`
        : `No fuel-burn telemetry landed in this window.`,
    },
  ]
}
