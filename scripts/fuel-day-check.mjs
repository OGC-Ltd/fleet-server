/**
 * Why does a unit's day show the fuel it does? Read-only.
 * Prints the day's fuel balance as the Recovery report computes it, plus the
 * probe readings behind it (hourly), refills, drains and the fuel-used field.
 *
 * Run on the box from ~/prod/fleet-server:
 *   node scripts/fuel-day-check.mjs "KDX 130Y" 2026-11-06
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = (p) => pathToFileURL(path.resolve('dist/src', p)).href
const { prisma } = await import(dist('lib/prisma.js'))
const { getDayReportData } = await import(dist('modules/trips/trip-report.service.js'))
const { buildTripReport } = await import(dist('modules/trips/trip-report.build.js'))

const plate = process.argv[2] ?? 'KDX 130Y'
const day = process.argv[3] ?? '2026-11-06'
const from = new Date(`${day}T00:00:00+03:00`), to = new Date(`${day}T23:59:59.999+03:00`)
const eat = (d) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(11, 16)

const vs = await prisma.vehicle.findMany({
  where: { registrationPlate: { in: [plate, plate.replace(/\s+/g, '')], mode: 'insensitive' } },
  select: { id: true, organisationId: true, registrationPlate: true, name: true, tankCapacityLitres: true },
})
console.log('vehicles', JSON.stringify(vs))
for (const v of vs) {
  const data = await getDayReportData(v.organisationId, v.id, day, null, { withConduct: false })
  const rep = buildTripReport(data)
  console.log('\n== report', v.registrationPlate, { distanceKm: rep.summary.distanceKm, stops: rep.stopsTotal, fuelUsedL: rep.summary.fuelUsedL })
  console.log('balance', JSON.stringify(data.fuel.balance))

  const fx = await prisma.vehicleTelemetry.findMany({
    where: { vehicleId: v.id, capturedAt: { gte: from, lte: to } }, orderBy: { capturedAt: 'asc' },
    select: { capturedAt: true, fuelLevelMl: true, fuelUsedMl: true, speedKmh: true, engineOn: true, ignitionKnown: true },
  })
  const lv = fx.filter((f) => f.fuelLevelMl != null)
  const used = fx.filter((f) => f.fuelUsedMl != null)
  console.log(`rows ${fx.length} · with fuel level ${lv.length} (>=1 L: ${lv.filter((f) => f.fuelLevelMl >= 1000).length}) · with fuel_used ${used.length} (sum ${used.reduce((n, f) => n + f.fuelUsedMl, 0) / 1000} L)`)
  if (lv.length) {
    const L = lv.map((f) => f.fuelLevelMl / 1000)
    console.log(`level min ${Math.min(...L)} max ${Math.max(...L)} first ${L[0]} last ${L.at(-1)} distinct ${new Set(L).size}`)
  }
  const hours = new Map()
  for (const f of fx) {
    const h = eat(f.capturedAt).slice(0, 2)
    const e = hours.get(h) ?? { n: 0, lv: [], moving: 0, on: 0 }
    e.n++; if (f.fuelLevelMl != null) e.lv.push(f.fuelLevelMl / 1000)
    if ((f.speedKmh ?? 0) > 5) e.moving++; if (f.engineOn) e.on++
    hours.set(h, e)
  }
  console.log('hour  rows moving engOn  level(first→last, min..max)')
  for (const [h, e] of hours) {
    const l = e.lv
    console.log(`${h}   ${String(e.n).padStart(4)} ${String(e.moving).padStart(6)} ${String(e.on).padStart(5)}  ${l.length ? `${l[0]}→${l.at(-1)} (${Math.min(...l)}..${Math.max(...l)})` : '-'}`)
  }
  const fills = await prisma.fuelFilling.findMany({ where: { vehicleId: v.id, filledAt: { gte: new Date(from.getTime() - 86400_000), lte: new Date(to.getTime() + 86400_000) } },
    select: { filledAt: true, filledMl: true, verdict: true, initialFuelLevelMl: true, finalFuelLevelMl: true } })
  console.log('fillings ±1 day', JSON.stringify(fills))
  const dr = await prisma.fuelTheft.findMany({ where: { vehicleId: v.id, beganAt: { gte: from, lte: to } },
    select: { beganAt: true, verdict: true, drainCause: true, measuredDropMl: true, cleanDropMl: true, reviewStatus: true } })
  console.log('drains', JSON.stringify(dr))
}
await prisma.$disconnect()
process.exit(0)
