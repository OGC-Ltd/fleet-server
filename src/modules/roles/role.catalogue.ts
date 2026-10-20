/**
 * Every organisation gets the standard roles.
 *
 * The organisation-scoped roles in ROLE_DEFINITIONS (HR, System Administrator,
 * Fleet Manager … Technician) are rows keyed to one organisation, and until
 * now only `npm run seed:rbac` wrote them. An organisation created after the
 * last seed run therefore had none: its user page offered nothing but the one
 * role somebody there already held, which is how a new tenant came to show
 * "System Administrator" alone.
 *
 * This creates the MISSING ones and nothing else. A role that already exists
 * is not renamed and its permissions are not touched, so an operator's hand
 * tuning survives; that is seed:rbac --preserve, minus the script. Platform
 * roles (Director, Platform Administrator) are one row for every organisation
 * and are not written here.
 *
 * Called when an organisation is created, and once at boot so every existing
 * organisation is brought up to the set without anybody running a seed.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { ROLE_DEFINITIONS } from '../../lib/permissions.js'

const ORG_ROLES = ROLE_DEFINITIONS.filter((r) => !r.platform)

/** Create the standard roles `orgIds` lack. Returns how many were created. */
export async function ensureCatalogueRoles(orgIds: string[]): Promise<number> {
  if (orgIds.length === 0) return 0
  const have = await prisma.role.findMany({
    where:  { organisationId: { in: orgIds }, slug: { in: ORG_ROLES.map((r) => r.slug) } },
    select: { organisationId: true, slug: true },
  })
  const held = new Set(have.map((r) => `${r.organisationId}|${r.slug}`))
  const missing = orgIds.flatMap((orgId) => ORG_ROLES.filter((r) => !held.has(`${orgId}|${r.slug}`)).map((def) => ({ orgId, def })))
  if (missing.length === 0) return 0

  const perms = await prisma.permission.findMany({ select: { id: true, slug: true } })
  const permId = new Map(perms.map((p) => [p.slug, p.id]))

  for (const { orgId, def } of missing) {
    const ids = def.permissions.map((s) => permId.get(s)).filter((id): id is string => !!id)
    // A permission the catalogue names but the table lacks is skipped, not
    // fatal: seed:rbac writes the catalogue, and one missing row should not
    // leave a whole organisation without its roles.
    if (ids.length < def.permissions.length) {
      logger.warn({ orgId, role: def.slug, missing: def.permissions.filter((s) => !permId.has(s)) }, 'role catalogue: permission not in table, skipped')
    }
    try {
      await prisma.$transaction(async (tx) => {
        const role = await tx.role.create({
          data:   { organisationId: orgId, slug: def.slug, name: def.name, description: def.description },
          select: { id: true },
        })
        if (ids.length) {
          await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true })
        }
      })
    } catch (err) {
      // Somebody else created it between the read and the write (a boot and
      // an organisation create racing): it exists, which is all we wanted.
      if ((err as { code?: string })?.code !== 'P2002') throw err
    }
  }
  logger.info({ created: missing.length, organisations: new Set(missing.map((m) => m.orgId)).size }, 'role catalogue: standard roles created')
  return missing.length
}

/** Boot: bring every organisation up to the standard set. Never fails the boot. */
export async function ensureAllOrganisationsHaveCatalogueRoles(): Promise<void> {
  try {
    const orgs = await prisma.organisation.findMany({ select: { id: true } })
    await ensureCatalogueRoles(orgs.map((o) => o.id))
  } catch (err) {
    logger.error({ err }, 'role catalogue: could not ensure standard roles')
  }
}
