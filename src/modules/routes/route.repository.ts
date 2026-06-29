import { prisma } from '../../lib/prisma.js'
import type { CreateRoute, UpdateRoute, RouteListQuery } from './route.schema.js'

const include = { waypoints: { orderBy: { sequence: 'asc' as const } } }

export async function create(orgId: string, dto: CreateRoute) {
  const { waypoints, ...routeData } = dto
  return prisma.route.create({
    data: {
      ...routeData,
      organisationId: orgId,
      waypoints: waypoints?.length
        ? { create: waypoints }
        : undefined,
    },
    include,
  })
}

export async function findAll(orgId: string, q: RouteListQuery) {
  const rows = await prisma.route.findMany({
    where: {
      organisationId: orgId,
      ...(q.isActive !== undefined ? { isActive: q.isActive } : {}),
      ...(q.cursor ? { id: { gt: q.cursor } } : {}),
    },
    include,
    orderBy: { createdAt: 'asc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return { data: rows, cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null, hasNextPage }
}

export async function findById(id: string, orgId: string) {
  return prisma.route.findFirst({ where: { id, organisationId: orgId }, include })
}

export async function update(id: string, orgId: string, dto: UpdateRoute) {
  const { waypoints, ...routeData } = dto
  return prisma.$transaction(async tx => {
    if (waypoints !== undefined) {
      await tx.routeWaypoint.deleteMany({ where: { routeId: id } })
    }
    return tx.route.update({
      where: { id },
      data: {
        ...routeData,
        ...(waypoints !== undefined ? { waypoints: { create: waypoints } } : {}),
      },
      include,
    })
  })
}

export async function remove(id: string, orgId: string) {
  const route = await prisma.route.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!route) return null
  return prisma.route.delete({ where: { id } })
}
