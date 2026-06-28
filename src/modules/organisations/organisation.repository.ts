import { prisma } from '../../lib/prisma.js'
import type { CreateOrgDto, UpdateOrgDto, ListOrgQuery } from './organisation.schema.js'

export async function findAll({ page, limit }: ListOrgQuery) {
  const skip = (page - 1) * limit
  const [data, total] = await prisma.$transaction([
    prisma.organisation.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.organisation.count(),
  ])
  return { data, total }
}

export async function findById(id: string) {
  return prisma.organisation.findUnique({ where: { id } })
}

export async function create(dto: CreateOrgDto) {
  return prisma.organisation.create({ data: dto })
}

export async function update(id: string, dto: UpdateOrgDto) {
  return prisma.organisation.update({ where: { id }, data: dto })
}
