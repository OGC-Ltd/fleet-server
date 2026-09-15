/**
 * Give every driver who has driven a vehicle the assignment that says so.
 *
 * ## Why this exists
 *
 * The Drivers page grew a Vehicle column. It reads the unit off the driver's
 * most recent TRIP, and falls back to an open `vehicle_assignments` row where
 * there is no trip to read — so the column is blank exactly where the fleet
 * has neither, and a roster of em-dashes is not a roster.
 *
 * `link-drivers.ts` fills that gap by hand: somebody reads a roster and types
 * plate-and-name pairs in. That is the only way for a driver nothing has ever
 * recorded driving. But most of these drivers HAVE driven — the trips are
 * there, carrying the vehicle — and typing in a fact the database already
 * holds is how the typed version comes to disagree with it. This derives them
 * instead, and leaves the hand roster for the ones it genuinely cannot answer.
 *
 * ## What it decides, and how conservatively
 *
 *   • only drivers with NO open assignment are considered — an existing
 *     posting is an operator's decision and is never overwritten
 *   • the unit is the one they drove MOST OFTEN in the window, and the most
 *     recent of those on a tie. Not simply the latest trip: one relief run on
 *     somebody else's lorry should not become a driver's posting
 *   • a vehicle already held by somebody else is REPORTED, never reassigned.
 *     Two drivers on one truck is an operational fact this script cannot
 *     adjudicate — the same rule link-drivers.ts states
 *   • a driver whose trips are spread evenly across several units (no unit
 *     holding a clear majority) is reported rather than guessed at
 *
 * The rows it writes carry a note saying they were derived and from what, so
 * an assignment nobody remembers making can be traced back to the trips that
 * made it.
 *
 * ## Dry run unless --apply
 *
 *   npm run backfill:driver-vehicles -- --org=MENENGAI
 *   npm run backfill:driver-vehicles -- --org=MENENGAI --apply
 *   npm run backfill:driver-vehicles -- --org=MENENGAI --days=180 --min-share=0.5
 *
 * `--days` is the trip history to weigh (default 90, matching the window the
 * Drivers page itself reads). `--min-share` is the fraction of a driver's
 * trips their top unit must hold before it counts as THEIR unit (default 0.6).
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]

const APPLY     = process.argv.includes('--apply')
const ORG_CODE  = arg('org')
const DAYS      = Number(arg('days') ?? 90)
const MIN_SHARE = Number(arg('min-share') ?? 0.6)

/** Every user holding a live driver role in the org. Same definition the
 *  drivers overview uses, so this backfills exactly the roster that page
 *  shows and not some other set of people. */
const DRIVER_ROLE_SLUGS = ['driver', 'senior_driver', 'junior_driver']

async function main() {
  if (!ORG_CODE) throw new Error('pass --org=CODE (e.g. --org=MENENGAI)')
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error('--days must be a positive number')
  if (!(MIN_SHARE > 0 && MIN_SHARE <= 1)) throw new Error('--min-share must be between 0 and 1')

  console.log(`\n🚚  Driver → vehicle backfill — ${APPLY ? 'APPLYING' : 'DRY RUN'}`)
  console.log(`    org ${ORG_CODE} · ${DAYS} days of trips · top unit must hold ${Math.round(MIN_SHARE * 100)}%\n`)

  const org = await prisma.organisation.findUnique({
    where: { code: ORG_CODE }, select: { id: true, name: true },
  })
  if (!org) throw new Error(`organisation ${ORG_CODE} not found`)

  const drivers = await prisma.user.findMany({
    where: {
      organisationId: org.id,
      deletedAt: null,
      userRoles: { some: { revokedAt: null, role: { slug: { in: DRIVER_ROLE_SLUGS } } } },
    },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  })
  if (drivers.length === 0) throw new Error(`${ORG_CODE} has no drivers`)

  const driverIds = drivers.map((d) => d.id)
  const since = new Date(Date.now() - DAYS * 86_400_000)

  // Open postings, so a driver who already has one is left entirely alone —
  // and so a vehicle held by somebody else can be named in the report.
  const open = await prisma.vehicleAssignment.findMany({
    where: { unassignedAt: null, vehicle: { organisationId: org.id } },
    select: {
      userId: true, vehicleId: true,
      user:    { select: { fullName: true } },
      vehicle: { select: { registrationPlate: true } },
    },
  })
  const postedDriver  = new Map(open.map((a) => [a.userId, a.vehicle.registrationPlate]))
  const vehicleHeldBy = new Map(open.map((a) => [a.vehicleId, a.user.fullName]))

  const trips = await prisma.trip.findMany({
    where: {
      driverId: { in: driverIds },
      beganAt:  { gte: since },
      vehicle:  { organisationId: org.id },
    },
    select: {
      driverId: true, vehicleId: true, beganAt: true,
      vehicle: { select: { registrationPlate: true } },
    },
    orderBy: { beganAt: 'asc' },
  })

  /** driverId → vehicleId → { trips, lastAt, plate } */
  const byDriver = new Map<string, Map<string, { trips: number; lastAt: Date; plate: string }>>()
  for (const t of trips) {
    if (!t.driverId) continue
    const units = byDriver.get(t.driverId) ?? new Map()
    const u = units.get(t.vehicleId) ?? { trips: 0, lastAt: t.beganAt, plate: t.vehicle.registrationPlate }
    u.trips++
    if (t.beganAt > u.lastAt) u.lastAt = t.beganAt
    units.set(t.vehicleId, u)
    byDriver.set(t.driverId, units)
  }

  let assigned = 0, alreadyPosted = 0, noTrips = 0, split = 0, conflicts = 0

  for (const d of drivers) {
    const posted = postedDriver.get(d.id)
    if (posted) {
      alreadyPosted++
      console.log(`  ${d.fullName.padEnd(22)} posted already → ${posted}`)
      continue
    }

    const units = [...(byDriver.get(d.id) ?? new Map()).entries()]
    if (units.length === 0) {
      noTrips++
      console.log(`  ${d.fullName.padEnd(22)} ✗ no trips in ${DAYS} days — needs link-drivers.ts`)
      continue
    }

    // Most trips, then most recent.
    units.sort((a, b) => b[1].trips - a[1].trips || b[1].lastAt.getTime() - a[1].lastAt.getTime())
    const [vehicleId, top] = units[0]
    const total = units.reduce((n, [, u]) => n + u.trips, 0)
    const share = top.trips / total

    if (share < MIN_SHARE) {
      split++
      const spread = units.slice(0, 3).map(([, u]) => `${u.plate} ×${u.trips}`).join(', ')
      console.log(`  ${d.fullName.padEnd(22)} ? spread across units (${spread}) — left for an operator`)
      continue
    }

    const heldBy = vehicleHeldBy.get(vehicleId)
    if (heldBy) {
      conflicts++
      console.log(`  ${d.fullName.padEnd(22)} ✗ ${top.plate} held by ${heldBy} — left alone`)
      continue
    }

    assigned++
    console.log(
      `  ${d.fullName.padEnd(22)} → ${top.plate.padEnd(9)} ` +
      `${top.trips}/${total} trips (${Math.round(share * 100)}%), last ${top.lastAt.toISOString().slice(0, 10)}`)

    if (APPLY) {
      await prisma.vehicleAssignment.create({
        data: {
          vehicleId, userId: d.id,
          assignmentType: 'PRIMARY',
          notes:
            `Derived from trip history on ${new Date().toISOString().slice(0, 10)}: ` +
            `${top.trips} of ${total} trips in ${DAYS} days`,
        },
      })
      // Held from here on, so two drivers in one run cannot both take it.
      vehicleHeldBy.set(vehicleId, d.fullName)
    }
  }

  console.log(
    `\ndrivers ${drivers.length} · assignments ${assigned} · already posted ${alreadyPosted} · ` +
    `no trips ${noTrips} · spread ${split} · conflicts ${conflicts}`)
  if (noTrips) console.log(`${noTrips} driver(s) have no trips at all — those are link-drivers.ts's job.`)
  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.')
}

main()
  .catch((e) => { console.error('\n✗', e.message); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
