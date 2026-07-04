/**
 * Idempotent silo seed — Sukari Industries Limited.
 *
 * Unlike seed.ts (which TRUNCATEs everything), this script only upserts silo
 * rows for the existing organisation, so it is safe to run repeatedly and does
 * NOT touch any other data.
 *
 * Run: npm run seed:silos
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

// Sukari HQ processing plant + regional distribution depots (match the anchors
// used by the fleet simulator so storage sits where the trucks/tractors run).
const SILOS: {
  code: string; name: string; locationName: string;
  lat: number; lng: number; capacityTonnes: number; storedTonnes: number;
  sugarType: 'RAW' | 'PROCESSED'
}[] = [
  { code: 'SILO-HQ-01', name: 'Sukari HQ Silo 1',  locationName: 'Sukari Industries, Kakamega', lat: 0.3358, lng: 34.4928, capacityTonnes: 5000, storedTonnes: 4120, sugarType: 'PROCESSED' },
  { code: 'SILO-HQ-02', name: 'Sukari HQ Silo 2',  locationName: 'Sukari Industries, Kakamega', lat: 0.3361, lng: 34.4931, capacityTonnes: 5000, storedTonnes: 4870, sugarType: 'PROCESSED' },
  { code: 'SILO-HQ-03', name: 'Sukari HQ Raw Bay', locationName: 'Sukari Industries, Kakamega', lat: 0.3354, lng: 34.4925, capacityTonnes: 8000, storedTonnes: 3200, sugarType: 'RAW' },
  { code: 'WH-KSM-01',  name: 'Kisumu Depot Store', locationName: 'Kisumu Depot',   lat: -0.0917, lng: 34.7679, capacityTonnes: 3000, storedTonnes: 1980, sugarType: 'PROCESSED' },
  { code: 'WH-NKR-01',  name: 'Nakuru Depot Store', locationName: 'Nakuru Depot',   lat: -0.3031, lng: 36.0800, capacityTonnes: 3000, storedTonnes: 2910, sugarType: 'PROCESSED' },
  { code: 'WH-NBI-01',  name: 'Nairobi DC Store',   locationName: 'Nairobi Depot',  lat: -1.2921, lng: 36.8219, capacityTonnes: 4000, storedTonnes: 2450, sugarType: 'PROCESSED' },
  { code: 'WH-ELD-01',  name: 'Eldoret Depot Store',locationName: 'Eldoret Depot',  lat: 0.5143,  lng: 35.2698, capacityTonnes: 2500, storedTonnes: 1310, sugarType: 'PROCESSED' },
  { code: 'WH-MSA-01',  name: 'Mombasa Export Store',locationName:'Mombasa Depot',  lat: -4.0435, lng: 39.6682, capacityTonnes: 6000, storedTonnes: 5720, sugarType: 'PROCESSED' },
  { code: 'WH-WTM-01',  name: 'Watamu Coastal Store',locationName:'Watamu Depot',   lat: -3.3573, lng: 40.0206, capacityTonnes: 2500, storedTonnes: 1640, sugarType: 'PROCESSED' },
]

// Fill ratio → status. >95% critical (overfull), >85% warning, else ok.
function statusFor(stored: number, capacity: number): string {
  const pct = capacity > 0 ? stored / capacity : 0
  if (pct > 0.95) return 'critical'
  if (pct > 0.85) return 'warning'
  return 'ok'
}

async function main() {
  console.log('\n🌱  Seeding silos — Sukari Industries Limited\n')

  const org = await prisma.organisation.findFirst({ where: { code: 'SUKARI' }, select: { id: true } })
    ?? await prisma.organisation.findFirst({ select: { id: true } })
  if (!org) throw new Error('No organisation found — run `npm run seed` first')

  for (const s of SILOS) {
    const status = statusFor(s.storedTonnes, s.capacityTonnes)
    await prisma.silo.upsert({
      where:  { organisationId_code: { organisationId: org.id, code: s.code } },
      update: { name: s.name, locationName: s.locationName, lat: s.lat, lng: s.lng,
                capacityTonnes: s.capacityTonnes, storedTonnes: s.storedTonnes, sugarType: s.sugarType, status },
      create: { organisationId: org.id, ...s, status },
    })
  }

  const total = SILOS.reduce((a, s) => a + s.storedTonnes, 0)
  console.log(`  ✓ ${SILOS.length} silos upserted — ${total.toLocaleString()} t stored\n`)
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => pool.end())
