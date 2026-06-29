import { prisma } from '../../lib/prisma.js'
import type { UpsertCargo } from './cargo.schema.js'

async function verifyTripOrg(tripId: string, orgId: string) {
  return prisma.trip.findFirst({
    where: { id: tripId, organisationId: orgId },
    select: { id: true },
  })
}

export async function upsertManifest(tripId: string, orgId: string, dto: UpsertCargo) {
  const trip = await verifyTripOrg(tripId, orgId)
  if (!trip) return null
  return prisma.cargoManifest.upsert({
    where:  { tripId },
    create: { tripId, ...dto },
    update: dto,
  })
}

export async function getManifest(tripId: string, orgId: string) {
  const trip = await verifyTripOrg(tripId, orgId)
  if (!trip) return null
  return prisma.cargoManifest.findUnique({ where: { tripId } })
}

export async function deleteManifest(tripId: string, orgId: string) {
  const trip = await verifyTripOrg(tripId, orgId)
  if (!trip) return null
  const manifest = await prisma.cargoManifest.findUnique({ where: { tripId }, select: { tripId: true } })
  if (!manifest) return { deleted: false }
  await prisma.cargoManifest.delete({ where: { tripId } })
  return { deleted: true }
}
