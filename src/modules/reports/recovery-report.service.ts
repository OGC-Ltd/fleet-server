import { ConflictError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayBounds, getDayReportData } from '../trips/trip-report.service.js'
import { buildTripReport } from '../trips/trip-report.build.js'

export const RECOVERY_VEHICLES = [
  { plate: 'KDX 130Y', recoveryType: 'mechanical' },
  { plate: 'KCS 969P', recoveryType: 'mechanical' },
  { plate: 'KDC 099U', recoveryType: 'mechanical' },
  { plate: 'KDX 131Y', recoveryType: 'puncture' },
] as const

export type RecoveryVehiclePlate = (typeof RECOVERY_VEHICLES)[number]['plate']

const normalisePlate = (plate: string) => plate.replace(/\s+/g, '').toUpperCase()

export async function getRecoveryVehicleReport(
  orgId: string, day: string, vehicleIds: Set<string> | null = null, vehiclePlate?: RecoveryVehiclePlate,
) {
  fleetDayBounds(day)
  const now = Date.now()
  const roster = vehiclePlate ? RECOVERY_VEHICLES.filter(({ plate }) => plate === vehiclePlate) : RECOVERY_VEHICLES
  const plates = roster.flatMap(({ plate }) => [plate, plate.replace(/\s+/g, '')])
  const vehicles = vehicleIds?.size === 0 ? [] : await prisma.vehicle.findMany({
    where: {
      organisationId: orgId,
      registrationPlate: { in: plates, mode: 'insensitive' },
      ...(vehicleIds ? { id: { in: [...vehicleIds] } } : {}),
    },
    select: { id: true, registrationPlate: true },
  })

  const rows = await Promise.all(roster.map(async (target) => {
    const matches = vehicles.filter(v => normalisePlate(v.registrationPlate) === normalisePlate(target.plate))
    if (matches.length > 1) throw new ConflictError(`Multiple vehicles match recovery registration ${target.plate}`)
    if (matches.length === 0) {
      return {
        ...target, available: false, hasTelemetry: false, distanceKm: null, route: [],
        fuelConsumedL: null, stopsTotal: null, stops: [],
      }
    }

    const data = await getDayReportData(orgId, matches[0]!.id, day, null, { withConduct: false })
    const report = buildTripReport(data)
    const hasTelemetry = report.track.length > 0
    return {
      ...target,
      available: true,
      hasTelemetry,
      distanceKm: hasTelemetry ? report.summary.distanceKm : null,
      route: report.track,
      fuelConsumedL: hasTelemetry
        ? (data.fuel.balance ? data.fuel.balance.consumedL : report.summary.fuelUsedL)
        : null,
      stopsTotal: hasTelemetry ? report.stopsTotal : null,
      stops: report.stops.map(stop => ({
        arrivedAt: stop.t,
        leftAt: stop.endT,
        durationMs: stop.ms,
        location: stop.place,
        remark: stop.remark,
        lat: stop.lat,
        lng: stop.lng,
      })),
    }
  }))

  return { day, timezone: 'Africa/Nairobi', generatedAt: now, vehicles: rows }
}
