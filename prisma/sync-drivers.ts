/**
 * Driver registry + vehicle-assignment sync — RaiFactorySuite (factorysuite).
 *
 * Two passes, both RE-RUNNABLE:
 *
 *  1. DRIVERS  (GET /drivers)  → users, upserted by `externalId` (provider
 *     UUID), each granted the org's `driver` role so the Drivers roster and
 *     RBAC see them.
 *
 *  2. ASSIGNMENTS (GET /dispatches) → vehicle_assignments. The provider has no
 *     "assignment" resource: the driver↔vehicle link exists only in the
 *     dispatch log, which pairs `vehicleNumberPlate` with `driverName`. So an
 *     assignment is DERIVED from dispatch records:
 *       • open dispatch  (actualReturnTime = null, status DISPATCHED/OVERDUE)
 *         → CURRENT assignment  (unassignedAt = null)
 *       • closed dispatch (has actualReturnTime)
 *         → HISTORICAL assignment (assignedAt → unassignedAt)
 *     CANCELLED dispatches are ignored — the vehicle never went out.
 *
 * Nothing is invented: drivers the dispatch log never mentions simply hold no
 * assignment, and vehicles that were never dispatched show "Unassigned".
 *
 * KNOWN PROVIDER LIMIT: /dispatches is hard-capped at 1000 rows and ignores
 * offset/page/skip, so only the most recent window (~4 days) is visible.
 * Re-running regularly accumulates history in our DB.
 *
 * Run: npm run sync:drivers
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import type { Prisma, UserStatus } from '../generated/prisma/client.js'
import { parseProviderTime } from '../src/lib/provider-time.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.CONTROLTECH_API_URL ?? 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.CONTROLTECH_API_KEY ?? ''

// Provider factoryCode → our organisation code (mirrors sync-vehicles.ts).
const FACTORY_TO_ORG: Record<string, string> = {
  NDHIWA: 'SUKARI',
}

interface CtDriver {
  id:            string
  factoryCode:   string
  driverType:    string
  name:          string
  idNumber:      string | null
  staffId:       string | null
  licenseNumber: string | null
  licenseExpiry: string | null
  phoneNumber:   string | null
  status:        string | null
  active:        boolean
}

interface CtDispatch {
  id:                 string
  factoryCode:        string
  vehicleNumberPlate: string
  driverName:         string
  status:             string
  dispatchTime:       string | null
  actualReturnTime:   string | null
  destinationOrPurpose: string | null
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

async function get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { accept: 'application/json', 'X-API-Key': API_KEY },
  })
  if (!res.ok) throw new Error(`RaiFactorySuite ${path} responded ${res.status}`)
  const body = await res.json() as T[] | { data?: T[] }
  const list = Array.isArray(body) ? body : (body.data ?? [])
  if (!Array.isArray(list)) throw new Error(`RaiFactorySuite ${path} returned an unexpected shape`)
  return list
}

/**
 * Employment standing in OUR model. The provider's `status` mixes duty state
 * (ON_DUTY / OFF_DUTY) with employment (TERMINATED); only the latter maps.
 */
function toUserStatus(d: CtDriver): UserStatus {
  if (!d.active || d.status === 'TERMINATED') return 'TERMINATED'
  return 'ACTIVE'
}

async function main() {
  if (!API_KEY) throw new Error('CONTROLTECH_API_KEY is not set')
  console.log(`\n🔄  Driver sync — ${API_URL}\n`)

  const [drivers, dispatches] = await Promise.all([
    get<CtDriver>('/drivers?limit=2000'),
    get<CtDispatch>('/dispatches?limit=2000'),
  ])
  if (drivers.length === 0) {
    throw new Error('RaiFactorySuite /drivers returned no records — refusing to deactivate the whole roster')
  }
  console.log(`  ← ${drivers.length} drivers, ${dispatches.length} dispatch records`)

  // ── orgs + the driver role each synced user is granted ────────────────────
  const orgByCode  = new Map<string, { id: string }>()
  const roleByOrg  = new Map<string, string>()
  for (const code of new Set(Object.values(FACTORY_TO_ORG))) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
    if (!org) { console.warn(`  ⚠ organisation ${code} not found — its drivers will be skipped`); continue }
    orgByCode.set(code, org)
    const role = await prisma.role.findFirst({
      where:  { organisationId: org.id, slug: 'driver' },
      select: { id: true },
    })
    if (role) roleByOrg.set(org.id, role.id)
    else console.warn(`  ⚠ ${code} has no 'driver' role — users will be created without one`)
  }

  // ── pass 1: drivers → users ───────────────────────────────────────────────
  let created = 0, updated = 0, skipped = 0, failed = 0
  const userIdByName = new Map<string, string[]>()   // normalised name → user ids

  for (const d of drivers) {
    const orgCode = FACTORY_TO_ORG[d.factoryCode]
    const org = orgCode ? orgByCode.get(orgCode) : undefined
    if (!org) { skipped++; continue }

    // "PENDING" is the provider's placeholder for "no licence on file" — store
    // NULL rather than a fake licence number.
    const licence = d.licenseNumber && !/^pending$/i.test(d.licenseNumber.trim())
      ? d.licenseNumber.trim()
      : null

    const data = {
      organisationId: org.id,
      fullName:       d.name.trim(),
      phone:          d.phoneNumber?.trim() || null,
      licenceNumber:  licence,
      employeeId:     d.staffId?.trim() || null,
      dutyStatus:     d.status ?? null,
      driverType:     d.driverType ?? null,
      status:         toUserStatus(d),
    } satisfies Prisma.UserUncheckedUpdateInput

    try {
      const existing = await prisma.user.findUnique({ where: { externalId: d.id }, select: { id: true } })
      let userId: string
      if (existing) {
        await prisma.user.update({ where: { externalId: d.id }, data })
        userId = existing.id
        updated++
      } else {
        // email stays NULL — the provider holds none and drivers don't log in.
        const u = await prisma.user.create({ data: { ...data, externalId: d.id }, select: { id: true } })
        userId = u.id
        created++
      }

      const roleId = roleByOrg.get(org.id)
      if (roleId) {
        const has = await prisma.userRole.findFirst({
          where: { userId, roleId, revokedAt: null }, select: { userId: true },
        })
        if (!has) await prisma.userRole.create({ data: { userId, roleId } })
      }

      const key = norm(d.name)
      userIdByName.set(key, [...(userIdByName.get(key) ?? []), userId])
    } catch (err) {
      failed++
      console.error(`  ✗ ${d.name} (${d.id}):`, err instanceof Error ? err.message.split('\n').at(-1) : err)
    }
  }
  console.log(`  ✓ drivers: created ${created}, updated ${updated}, skipped ${skipped} (unmapped factory), failed ${failed}`)

  // ── pass 2: dispatches → vehicle assignments ──────────────────────────────
  // The dispatch log is the ONLY driver↔vehicle link the provider exposes, and
  // it joins by name + plate (no ids).
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, registrationPlate: true } })
  const vehicleIdByPlate = new Map(vehicles.map(v => [norm(v.registrationPlate), v.id]))

  // A name shared by two drivers can't be resolved to one person — record it
  // rather than guessing.
  const ambiguousNames = [...userIdByName.entries()].filter(([, ids]) => ids.length > 1).map(([n]) => n)

  let assignCreated = 0, assignClosed = 0, ambiguous = 0, unmatchedDriver = 0, unmatchedVehicle = 0, cancelled = 0

  // Oldest first so the newest dispatch wins the "current" assignment.
  const ordered = [...dispatches].sort((a, b) => (a.dispatchTime ?? '').localeCompare(b.dispatchTime ?? ''))

  for (const dp of ordered) {
    if (dp.status === 'CANCELLED') { cancelled++; continue }

    const nameKey = norm(dp.driverName)
    const ids = userIdByName.get(nameKey)
    if (!ids || ids.length === 0) { unmatchedDriver++; continue }
    if (ids.length > 1) { ambiguous++; continue }
    const userId = ids[0]!

    const vehicleId = vehicleIdByPlate.get(norm(dp.vehicleNumberPlate))
    if (!vehicleId) { unmatchedVehicle++; continue }

    // Offsetless EAT timestamps — see src/lib/provider-time.ts.
    const assignedAt = parseProviderTime(dp.dispatchTime)
    if (!assignedAt || Number.isNaN(assignedAt.getTime())) continue
    const returnedAt = parseProviderTime(dp.actualReturnTime)
    const isOpen = returnedAt == null && dp.status !== 'COMPLETED'

    // One assignment row per dispatch, keyed by the dispatch id in `notes` so
    // re-runs update instead of duplicating.
    const marker = `controltech:dispatch:${dp.id}`
    const existing = await prisma.vehicleAssignment.findFirst({
      where: { notes: marker }, select: { id: true },
    })

    const payload = {
      vehicleId,
      userId,
      assignmentType: 'PRIMARY' as const,
      assignedAt,
      unassignedAt:   isOpen ? null : (returnedAt ?? assignedAt),
      notes:          marker,
    }

    if (existing) {
      await prisma.vehicleAssignment.update({ where: { id: existing.id }, data: payload })
      if (!isOpen) assignClosed++
    } else {
      await prisma.vehicleAssignment.create({ data: payload })
      assignCreated++
      if (!isOpen) assignClosed++
    }
  }

  console.log(`  ✓ assignments: ${assignCreated} created (${assignClosed} already returned)`)
  if (cancelled)        console.log(`    · ${cancelled} cancelled dispatches ignored`)
  if (ambiguous)        console.log(`    · ${ambiguous} skipped — driver name shared by >1 person: ${ambiguousNames.join(', ')}`)
  if (unmatchedDriver)  console.log(`    · ${unmatchedDriver} skipped — driver name not in the roster`)
  if (unmatchedVehicle) console.log(`    · ${unmatchedVehicle} skipped — plate not in the vehicle registry`)

  const activeAssignments = await prisma.vehicleAssignment.count({ where: { unassignedAt: null } })
  const roster = await prisma.user.count({ where: { externalId: { not: null }, status: 'ACTIVE' } })
  console.log(`\n✅  Sync complete — ${roster} active drivers, ${activeAssignments} vehicles currently assigned.\n`)
}

main()
  .catch(err => {
    console.error('\n❌  sync-drivers failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
