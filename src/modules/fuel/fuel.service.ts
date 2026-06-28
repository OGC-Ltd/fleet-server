import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './fuel.repository.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery } from './fuel.schema.js'

export const listFillings = (orgId: string, q: ListFillingQuery) => repo.findAllFillings(orgId, q)

export async function getFilling(orgId: string, id: string) {
  const item = await repo.findFillingById(orgId, id)
  if (!item) throw new NotFoundError('Fuel filling')
  return item
}

export const createFilling = (dto: CreateFillingDto) => repo.createFilling(dto)

export const listThefts = (orgId: string, q: ListTheftQuery) => repo.findAllThefts(orgId, q)

export async function getTheft(orgId: string, id: string) {
  const item = await repo.findTheftById(orgId, id)
  if (!item) throw new NotFoundError('Fuel theft')
  return item
}

export const createTheft = (dto: CreateTheftDto) => repo.createTheft(dto)
