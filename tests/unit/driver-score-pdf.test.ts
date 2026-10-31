/**
 * The driver scorecard drawn as a PDF (driver-score.pdf), from a scorecard the
 * service built over mocked records: a summary, then a section per driver.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import fs from 'node:fs'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({
  getAlarms: vi.fn(async () => ({ cameras: 0, incidents: [], partial: false, stale: false })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { getDriverScorecard, type ScorecardAnswer } from '../../src/modules/driver-score/driver-score.service.js'
import { renderScorecardPdf, scorecardFileName, standingText } from '../../src/modules/driver-score/driver-score.pdf.js'

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`)
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
const DRIVERS = [['u1', 'v1', 'Wilson Koskey', 'KCA 227M'], ['u2', 'v2', 'Paul Kanui Njoroge', 'KCA 456U'], ['u3', 'v3', 'Benson Mburu Kamau', 'KDE 138E']] as const
const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22']

let answer: ScorecardAnswer
beforeAll(async () => {
  ;(prismaMock.$queryRaw as any).mockResolvedValue([])   // no driven-day rollup rows: trips and fuel give the days
  prismaMock.organisation.findUnique.mockResolvedValue({ name: 'Kabras Bioenergy', code: 'KABRAS' } as never)
  prismaMock.vehicle.findMany.mockResolvedValue(DRIVERS.map(([, v, , plate]) => ({ id: v, registrationPlate: plate })) as never)
  prismaMock.vehicleAssignment.findMany.mockResolvedValue(DRIVERS.map(([u, v, name]) => ({
    vehicleId: v, userId: u, assignedAt: new Date('2026-01-01T00:00:00Z'), unassignedAt: null, notes: null, user: { fullName: name } })) as never)
  prismaMock.dispatch.findMany.mockResolvedValue(DAYS.flatMap((day, i) => DRIVERS.map(([, v], j) => ({
    vehicleId: v, dispatchedAt: at(day, `0${7 + j}:00`), factoryCode: null, destination: j === 2 ? 'SUKARI' : 'KABRAS', externalId: `d${i}${j}`, serialNumber: null }))) as never)
  prismaMock.speedingIncident.findMany.mockResolvedValue([
    { vehicleId: 'v1', startedAt: at('2026-10-20', '09:00'), overByKmh: 6 }, { vehicleId: 'v1', startedAt: at('2026-10-20', '10:00'), overByKmh: 18 },
  ] as never)
  prismaMock.providerAlert.findMany.mockResolvedValue([1, 2, 3, 4, 5, 6].map(i => ({ vehicleId: 'v2', createdAt: at('2026-10-21', `1${i}:00`), raw: { ms2: 0.6 } })) as never)
  prismaMock.fuelDailyTrend.findMany.mockResolvedValue(DAYS.flatMap(day => DRIVERS.map(([, v], j) => ({
    vehicleId: v, day: new Date(`${day}T00:00:00Z`), distanceM: 200_000, engineBurnMl: [90_000, 105_000, 120_000][j], engineSeconds: 5 * 3600 }))) as never)
  prismaMock.vehicleDailyStat.findMany.mockResolvedValue(DAYS.flatMap(day => DRIVERS.map(([, v]) => ({
    vehicleId: v, day: new Date(`${day}T00:00:00Z`), engineFixes: 100, idleFixes: 20 }))) as never)
  answer = await getDriverScorecard('org1', '2026-10-20', '2026-10-22')
})

describe('the driver scorecard PDF', () => {
  it('draws the summary, then a page per driver', async () => {
    const buf = await renderScorecardPdf(answer, { allDrivers: true, generatedAt: Date.parse('2026-10-31T09:00:00Z') })
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, buf)
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pages(buf)).toBe(1 + answer.drivers.length)
  })

  it('draws one driver alone, named in the file', async () => {
    const one = { ...answer, drivers: answer.drivers.filter(d => d.driverId === 'u1') }
    expect(pages(await renderScorecardPdf(one, { allDrivers: false }))).toBe(2)
    expect(scorecardFileName(one)).toBe('Driver scorecard Wilson Koskey 2026-10-20 to 2026-10-22.pdf')
    expect(scorecardFileName(answer)).toBe('Driver scorecard Kabras Bioenergy 2026-10-20 to 2026-10-22.pdf')
  })

  it('names the standing: a suspension outranks lost trip pay', () => {
    expect(standingText(answer.drivers.find(d => d.driverId === 'u2')!)).toEqual({ text: 'Suspension', flag: true })
    expect(standingText(answer.drivers.find(d => d.driverId === 'u3')!)).toEqual({ text: 'Clear', flag: false })
  })
})
