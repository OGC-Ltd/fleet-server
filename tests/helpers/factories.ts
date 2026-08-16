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
    // Null by default: the yard is MEASURED from telemetry by
    // sync:destinations, so a fresh organisation genuinely has none yet, and
    // anything that reads it must cope with that.
    hubLat: null,
    hubLng: null,
    // Likewise the gate: supplied by the operator per site, so absent until
    // someone provides it — which is the case yard-departure falls back for.
    gateLat: null,
    gateLng: null,
    gateRadiusM: null,
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
    externalId: null,
    dutyStatus: null,
    driverType: null,
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
    externalId: null,
    vehicleType: 'AMBULANCE',
    status: null,
    isActive: true,
    fuelEfficiencyKmpl: null,
    tankCapacityLitres: null,
    // Unknown by default, which is the state of almost the whole fleet — the
    // column exists to be filled in by hand as models are supplied.
    model: null,
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
    // Null by default: a factory trip is not from a dispatch unless a test says
    // so. Only trips the builder measured carry this.
    dispatchId: null,
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
    // Unjudged by default, matching a freshly synced row — see
    // modules/fuel/fuel-filling-adjudication.
    verdict: 'PENDING',
    verdictAt: null,
    verdictReason: null,
    verdictConfidence: null,
    observedRiseMl: null,
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
    // Unjudged by default, which is what the provider's claim starts as —
    // see modules/fuel/fuel-adjudication.
    verdict: 'PENDING',
    verdictAt: null,
    recoveredMl: null,
    verdictReason: null,
    verdictConfidence: null,
    // Unclassified by default: a cause is only assigned once the verdict has
    // settled as DRAIN — see modules/fuel/fuel-theft-classifier.
    drainCause: null,
    causeConfidence: null,
    causeReason: null,
    ...overrides,
  }
}
