/**
 * Seed the permission catalogue and the roles built from it.
 *
 * ADDITIVE and idempotent, unlike prisma/seed.ts — which TRUNCATEs roles,
 * user_roles and users among much else, and must never be pointed at a
 * database anybody is using. This one writes only the permissions and the
 * twelve role slugs named in src/lib/permissions.ts, and touches nothing else:
 * the 40 other seeded roles and all 551 existing role grants survive it.
 *
 * Roles come in two shapes. Ten are per-organisation, so each organisation
 * gets its own row and its own grants. Two are PLATFORM roles written once
 * with organisation_id NULL — super_admin and director — because "every
 * tenant" cannot be said by a row keyed to one tenant.
 *
 * By default a role that already exists has its permission set RECONCILED to
 * the matrix, and every addition and removal is printed. That is what you want
 * while the model is being established, and not what you want afterwards: once
 * an operator has tuned a role by hand, re-running this would undo them. Pass
 * --preserve to create missing roles and leave existing ones exactly as they
 * are.
 *
 * Run: npm run seed:rbac  [-- --preserve]
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import {
  PERMISSION_CATALOGUE,
  ROLE_DEFINITIONS,
  splitSlug,
  type PermissionSlug,
} from '../src/lib/permissions.js'

const PRESERVE = process.argv.includes('--preserve')

async function seedPermissions(): Promise<Map<string, string>> {
  const entries = Object.entries(PERMISSION_CATALOGUE) as [PermissionSlug, string][]
  let created = 0

  for (const [slug, name] of entries) {
    const { resource, action } = splitSlug(slug)
    // Upsert on `slug`, which is unique. `@@unique([resource, action])` holds
    // the same pair, so a slug whose halves collide with another row's would
    // fail here rather than silently duplicating the capability.
    const before = await prisma.permission.findUnique({ where: { slug }, select: { id: true } })
    await prisma.permission.upsert({
      where:  { slug },
      create: { slug, name, resource, action },
      update: { name, resource, action },
    })
    if (!before) created++
  }

  const all = await prisma.permission.findMany({ select: { id: true, slug: true } })
  console.log(`permissions: ${all.length} in catalogue (${created} new)`)
  return new Map(all.map((p) => [p.slug, p.id]))
}

/** Reconcile one role's grants to `want`. Returns [added, removed]. */
async function setGrants(
  roleId: string,
  want: readonly PermissionSlug[],
  permIds: Map<string, string>,
): Promise<[number, number]> {
  const wantIds = new Set(
    want.map((slug) => {
      const id = permIds.get(slug)
      if (!id) throw new Error(`Permission ${slug} is in the matrix but not the catalogue`)
      return id
    }),
  )

  const have = await prisma.rolePermission.findMany({
    where:  { roleId },
    select: { permissionId: true },
  })
  const haveIds = new Set(have.map((h) => h.permissionId))

  const toAdd    = [...wantIds].filter((id) => !haveIds.has(id))
  const toRemove = [...haveIds].filter((id) => !wantIds.has(id))

  if (toAdd.length) {
    await prisma.rolePermission.createMany({
      data: toAdd.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    })
  }
  if (toRemove.length) {
    await prisma.rolePermission.deleteMany({
      where: { roleId, permissionId: { in: toRemove } },
    })
  }
  return [toAdd.length, toRemove.length]
}

async function main(): Promise<void> {
  const permIds = await seedPermissions()

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } })
  console.log(`organisations: ${orgs.length} (${orgs.map((o) => o.code).join(', ')})`)

  for (const def of ROLE_DEFINITIONS) {
    // A platform role is written once, for no organisation. Prisma cannot
    // upsert against the partial unique index that keeps those slugs distinct
    // (organisation_id IS NULL), so it is a lookup and a branch.
    const targets = def.platform
      ? [null as string | null]
      : orgs.map((o) => o.id as string | null)

    for (const organisationId of targets) {
      let role = await prisma.role.findFirst({
        where:  { organisationId, slug: def.slug },
        select: { id: true },
      })

      const isNew = !role
      if (!role) {
        role = await prisma.role.create({
          data:   { organisationId, slug: def.slug, name: def.name, description: def.description },
          select: { id: true },
        })
      } else if (!PRESERVE) {
        await prisma.role.update({
          where: { id: role.id },
          data:  { name: def.name, description: def.description },
        })
      }

      const where = def.platform ? 'platform' : (orgs.find((o) => o.id === organisationId)?.code ?? '?')

      if (isNew || !PRESERVE) {
        const [added, removed] = await setGrants(role.id, def.permissions, permIds)
        const verb = isNew ? 'created' : 'reconciled'
        if (isNew || added || removed) {
          console.log(`  ${where.padEnd(10)} ${def.slug.padEnd(18)} ${verb} (+${added} -${removed})`)
        }
      } else {
        console.log(`  ${where.padEnd(10)} ${def.slug.padEnd(18)} kept as-is`)
      }
    }
  }

  console.log(PRESERVE ? '\ndone (--preserve: existing roles untouched)' : '\ndone')
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
