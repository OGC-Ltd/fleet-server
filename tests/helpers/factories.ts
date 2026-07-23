import type { Organisation, User, Role, Vehicle, VehicleGroup, Trip, FuelFilling, FuelTheft, ReportingPeriod } from '../../generated/prisma/client.js'

let seq = 0
const id = () => `cuid_${++seq}`
const now = () => new Date('2026-01-01T00:00:00Z')

export const TEST_ORG_ID = 'org_test_01'
export const TEST_USER_ID = 'usr_test_01'

export const testAuthUser = {
  id: TEST_USER_ID,
  organisationId: TEST_ORG_ID,
  email: 'test@fleet.dev',
  fullName: 'Test User',
  status: 'ACTIVE' as const,
}

export function makeOrg(overrides: Partial<Organisation> = {}): Organisation {
  return {
    id: id(),
    name: 'Acme Fleet',
    code: 'ACME',
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: id(),
    organisationId: TEST_ORG_ID,
    fullName: 'Jane Driver',
    email: `jane+${seq}@fleet.dev`,
    phone: null,
    licenceNumber: null,
    employeeId: null,
    status: 'ACTIVE',
    passwordHash: null,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    driverRatingScore: 5.0,
    ...overrides,
  }
}

export function makeVehicleGroup(overrides: Partial<VehicleGroup> = {}): VehicleGroup {
  return {
    id: id(),
    organisationId: TEST_ORG_ID,
    name: 'Ambulance',
    code: 'AMB',
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }
}

export function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: id(),
    organisationId: TEST_ORG_ID,
    vehicleGroupId: id(),
    name: 'Unit 01',
    registrationPlate: `ZZZ-${seq}`,
    deviceId: `dev-${seq}`,
    vehicleType: 'AMBULANCE',
    fuelEfficiencyKmpl: null,
    tankCapacityLitres: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }
}

export function makePeriod(overrides: Partial<ReportingPeriod> = {}): ReportingPeriod {
  return {
    id: id(),
    organisationId: TEST_ORG_ID,
    label: 'June 2026',
    periodStart: new Date('2026-06-01'),
    periodEnd: new Date('2026-06-30'),
    periodType: 'MONTHLY',
    ...overrides,
  }
}

export function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: id(),
    vehicleId: id(),
    driverId: null,
    reportingPeriodId: id(),
    beganAt: now(),
    endedAt: now(),
    initialLocation: null,
    finalLocation: null,
    durationSeconds: 3600,
    mileageKm: 120.5,
    avgSpeedKmh: null,
    maxSpeedKmh: null,
    engineHoursSeconds: null,
    consumedMl: null,
    consumedByFlsMl: null,
    ratesDeviationByFls: null,
    avgConsumptionL100km: null,
    avgConsumptionByFls: null,
    avgIdleConsumptionByFls: null,
    avgMileagePerUnitFls: null,
    initialFuelLevelMl: null,
    finalFuelLevelMl: null,
    maxFuelLevelMl: null,
    minFuelLevelMl: null,
    routeId: null,
    ...overrides,
  }
}

export function makeFilling(overrides: Partial<FuelFilling> = {}): FuelFilling {
  return {
    id: id(),
    vehicleId: id(),
    reportingPeriodId: id(),
    filledAt: now(),
    location: null,
    mileageAtFillKm: null,
    initialFuelLevelMl: null,
    filledMl: 50_000,
    finalFuelLevelMl: null,
    ...overrides,
  }
}

export function makeTheft(overrides: Partial<FuelTheft> = {}): FuelTheft {
  return {
    id: id(),
    vehicleId: id(),
    driverId: null,
    reportingPeriodId: id(),
    beganAt: now(),
    detectedAt: now(),
    initialLocation: null,
    initialFuelLevelMl: null,
    finalFuelLevelMl: null,
    stolenMl: 20_000,
    initialSpeedKmh: null,
    finalSpeedKmh: null,
    ...overrides,
  }
}
