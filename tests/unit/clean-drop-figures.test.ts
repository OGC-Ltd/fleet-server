/**
 * The litres a drain states are the fuel that LEFT: read between settled levels
 * (no slosh) and less what the engine burnt across the fall. MUFINDI: FTT 05,
 * 29 Oct 2026, stated 20.5 L for a ~9 L loss — a slosh spike at the top and half
 * an hour of idling plus 3.8 km of driving inside the window.
 */
import { describe, it, expect } from 'vitest'
import { measureFall, SLOSH_SETTLE_SECONDS, type FallSample } from '../../src/modules/fuel/fuel-drop-shape.js'
import { burnDuringFallMl, idleLphOf, type BurnBand } from '../../src/modules/fuel/fuel-theft-classifier.js'

const T0 = Date.parse('2026-10-29T06:00:00Z')
const MIN = 60_000
const at = (min: number) => new Date(T0 + min * MIN)
const s = (min: number, litres: number, speedKmh = 0, engine: boolean | 'unknown' = true): FallSample =>
  ({ capturedAt: at(min), fuelLevelMl: Math.round(litres * 1000), speedKmh, engineOn: engine === 'unknown' ? undefined : engine })
const asIs = <T>(xs: readonly T[]): T[] => [...xs]

describe('measureFall — slosh is not fuel', () => {
  // Standing at 300 L, a creep that throws the gauge to 309 L, settled again at
  // 300 L, then 9 L drawn off standing, then the drive away.
  const run: FallSample[] = [
    ...Array.from({ length: 10 }, (_, k) => s(k, 300)),
    s(10, 309, 4), s(10.5, 308, 3),               // creeping: the surface thrown up
    s(10.75, 305),                                  // stopped, still settling
    ...Array.from({ length: 8 }, (_, k) => s(12 + k, 300)),
    ...Array.from({ length: 8 }, (_, k) => s(20 + k, 300 - (k + 1) * 9 / 8)),
    ...Array.from({ length: 5 }, (_, k) => s(28 + k, 291)),
  ]
  const claim = { beganAt: at(20), detectedAt: at(27) }

  it('reads the top of the drop where the tank stood settled, not at the spike', () => {
    const m = measureFall(run, claim, asIs)!
    expect(m.clean.dropMl).toBe(9_000)
  })

  it('leaves the fall the classifier judges as it was: spike and all', () => {
    // The classifier's thresholds were set on this geometry; only the stated litres are cleaned.
    expect(measureFall(run, claim, asIs)!.evidence.dropMl).toBe(18_000)
  })

  it('keeps a reading within the settle time of a move out of it', () => {
    expect(SLOSH_SETTLE_SECONDS).toBe(60)
    const settledSpike = run.map(r => r.capturedAt.getTime() === at(10.75).getTime() ? { ...r, fuelLevelMl: 320_000 } : r)
    expect(measureFall(settledSpike, claim, asIs)!.clean.dropMl).toBe(9_000)
  })

  it('ends the fall where the vehicle drives away, not at a stop hours later', () => {
    const onward = [
      ...run,
      ...Array.from({ length: 30 }, (_, k) => s(33 + k, 291 - (k + 1) * 0.3, 45)),   // 9 L burnt on the road
      ...Array.from({ length: 20 }, (_, k) => s(63 + k, 282)),                       // parked at the next stop
    ]
    expect(measureFall(onward, claim, asIs)!.clean.dropMl).toBe(9_000)
  })

  it('keeps measuring an excavator whose GPS shows speed as its cab swings', () => {
    // Every other reading at 8 km/h, 30 s apart: never 500 m in one go, and
    // hardly a settled reading. The fall must still be measured.
    const swinging = Array.from({ length: 60 }, (_, k): FallSample => ({
      capturedAt: new Date(T0 + k * 30_000), speedKmh: k % 2 ? 8 : 0, engineOn: true,
      fuelLevelMl: k < 20 ? 400_000 : k < 30 ? 400_000 - (k - 19) * 2_000 : 380_000,
    }))
    const m = measureFall(swinging, { beganAt: new Date(T0 + 20 * 30_000), detectedAt: new Date(T0 + 30 * 30_000) }, asIs)
    expect(m!.clean.dropMl).toBe(20_000)
  })

  it('does not end a road drain at detection: a lorry already driving has not driven away', () => {
    // At 40 km/h throughout, 12 L down from minute 20 to 34; the provider ends it at 28.
    const road = Array.from({ length: 60 }, (_, k) => s(k, k < 20 ? 300 : k < 35 ? 300 - (k - 19) * 0.8 : 288, 40))
    expect(measureFall(road, { beganAt: at(20), detectedAt: at(28) }, asIs)!.clean.dropMl).toBe(12_000)
  })

  it('does not take a pause partway down as the bottom', () => {
    // Swinging at 6 km/h but for one stand at minute 22; 20 L down from 20 to 29.
    const paused = Array.from({ length: 40 }, (_, k) => s(k, k < 20 ? 400 : k < 30 ? 400 - (k - 19) * 2 : 380, k === 22 || k < 5 ? 0 : 6))
    expect(measureFall(paused, { beganAt: at(20), detectedAt: at(30) }, asIs)!.clean.dropMl).toBe(20_000)
  })

  it('falls back to every reading where the vehicle never stood', () => {
    const driving = run.map(r => ({ ...r, speedKmh: 40 }))
    expect(measureFall(driving, claim, asIs)!.clean.dropMl).toBe(18_000)
  })
})

describe('burnDuringFallMl — what the engine owns', () => {
  const truck: BurnBand = { lowLph: 4, highLph: 8, source: 'vehicle', kmPerL: 2.5 }

  it('takes the idle rate, not the working low edge, for an engine on standing', () => {
    const idle = Array.from({ length: 31 }, (_, k) => s(k, 300))
    expect(idleLphOf(truck)).toBe(1)                                // a quarter of 4 L/h
    expect(burnDuringFallMl(idle, truck)).toBe(500)                 // 30 min at 1 L/h
  })

  it('holds idle to 4 L/h however heavy the machine', () => {
    expect(idleLphOf({ lowLph: 59, highLph: 97, source: 'operator' })).toBe(4)   // D11
    expect(idleLphOf({ lowLph: 15, highLph: 25, source: 'operator' })).toBe(3.75) // large excavator
  })

  it('takes the low edge where plant moves with no km/L: it is working', () => {
    const plant: BurnBand = { lowLph: 15, highLph: 25, source: 'operator' }
    const swinging = Array.from({ length: 31 }, (_, k) => s(k, 300, 5))
    expect(burnDuringFallMl(swinging, plant)).toBe(7_500)           // 30 min at 15 L/h
  })

  it('takes the distance at the vehicle\'s km/L while it moved', () => {
    // 6 min at 38 km/h = 3.8 km, at 2.5 km/L = 1.52 L
    const drive = Array.from({ length: 7 }, (_, k) => s(k, 300, 38))
    expect(burnDuringFallMl(drive, truck)).toBe(1_520)
  })

  it('burns nothing where the ignition was not measured, or no rate is known', () => {
    const unknown = Array.from({ length: 31 }, (_, k) => s(k, 300, 0, 'unknown'))
    expect(burnDuringFallMl(unknown, truck)).toBe(0)
    expect(burnDuringFallMl(Array.from({ length: 31 }, (_, k) => s(k, 300)), null)).toBe(0)
  })

  it('never credits a silent gap with more than 15 minutes of running', () => {
    expect(burnDuringFallMl([s(0, 300), s(120, 300)], truck)).toBe(250)    // 15 min at 1 L/h idle
  })
})
