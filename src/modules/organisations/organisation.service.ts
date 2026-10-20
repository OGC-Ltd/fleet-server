import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './organisation.repository.js'
import { ensureCatalogueRoles } from '../roles/role.catalogue.js'
import type { CreateOrgDto, UpdateOrgDto, ListOrgQuery } from './organisation.schema.js'

export async function listOrganisations(query: ListOrgQuery) {
  return repo.findAll(query)
}

export async function getOrganisation(id: string) {
  const org = await repo.findById(id)
  if (!org) throw new NotFoundError('Organisation')
  return org
}

export async function createOrganisation(dto: CreateOrgDto) {
  const org = await repo.create(dto)
  // A new organisation starts with the standard roles, so its user page has
  // something to offer (roles/role.catalogue).
  await ensureCatalogueRoles([org.id])
  return org
}

export async function updateOrganisation(id: string, dto: UpdateOrgDto) {
  await getOrganisation(id) // ensure exists
  return repo.update(id, dto)
}
