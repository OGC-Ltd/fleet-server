import { createHash, randomBytes } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import type { CreateApiKey, UpdateApiKey } from './api-key.schema.js'

function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex')
}

const select = {
  id: true, organisationId: true, label: true, isActive: true,
  createdAt: true, expiresAt: true, lastUsedAt: true, createdById: true,
}

export async function create(orgId: string, createdById: string, dto: CreateApiKey) {
  const rawKey = randomBytes(32).toString('hex')
  const keyHash = sha256(rawKey)
  const apiKey = await prisma.ingestApiKey.create({
    data: {
      organisationId: orgId,
      label:          dto.label,
      keyHash,
      expiresAt:      dto.expiresAt ?? null,
      createdById,
    },
    select,
  })
  // Raw key returned ONCE — not stored
  return { ...apiKey, rawKey: `flt_${rawKey}` }
}

export async function findAll(orgId: string) {
  return prisma.ingestApiKey.findMany({
    where:   { organisationId: orgId },
    select,
    orderBy: { createdAt: 'desc' },
  })
}

export async function findById(id: string, orgId: string) {
  return prisma.ingestApiKey.findFirst({ where: { id, organisationId: orgId }, select })
}

export async function update(id: string, orgId: string, dto: UpdateApiKey) {
  const key = await prisma.ingestApiKey.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!key) return null
  return prisma.ingestApiKey.update({ where: { id }, data: dto, select })
}

export async function revoke(id: string, orgId: string) {
  const key = await prisma.ingestApiKey.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!key) return null
  return prisma.ingestApiKey.update({ where: { id }, data: { isActive: false }, select })
}
