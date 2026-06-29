import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './organisation.repository.js'
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
  return repo.create(dto)
}

export async function updateOrganisation(id: string, dto: UpdateOrgDto) {
  await getOrganisation(id) // ensure exists
  return repo.update(id, dto)
}
