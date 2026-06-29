import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './trip.repository.js'
import type { CreateTripDto, ListTripQuery } from './trip.schema.js'

export async function listTrips(orgId: string, query: ListTripQuery) {
  return repo.findAll(orgId, query)
}

export async function getTrip(orgId: string, tripId: string) {
  const trip = await repo.findById(orgId, tripId)
  if (!trip) throw new NotFoundError('Trip')
  return trip
}

export async function createTrip(dto: CreateTripDto) {
  return repo.create(dto)
}
