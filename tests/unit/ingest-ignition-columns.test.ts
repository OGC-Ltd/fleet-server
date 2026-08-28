/**
 * The ingest path's ignition provenance.
 *
 * These three columns exist so a judgement can tell a MEASURED engine state
 * from one inferred from speed. They were added and backfilled on 2026-08-26
 * and then went unwritten by ingest until 2026-08-27, which is the failure
 * these cases are here to stop recurring: every one of them is about a value
 * silently becoming something other than what a caller said.
 */

import { describe, it, expect } from 'vitest'
import { ignitionColumns } from '../../src/modules/ingest/ingest.service.js'
import type { TelemetryPayload } from '../../src/modules/ingest/ingest.schema.js'

const dto = (over: Partial<TelemetryPayload> = {}): TelemetryPayload => ({
  deviceId: 'wialon-1', capturedAt: new Date('2026-08-27T09:00:00Z'), ...over,
} as TelemetryPayload)

describe('ignitionColumns', () => {
  it('takes the explicit field over the raw payload', () => {
    const out = ignitionColumns(dto({
      ignitionKnown: true,
      rawPayload: { ignition_known: false },
    }))
    expect(out.ignitionKnown).toBe(true)
    expect(out.ignitionSource).toBe('SENSOR')
  })

  it('lets an explicit FALSE win over a stale raw payload', () => {
    // `??` not `||`: an adapter that says "this unit has no ignition line" must
    // not be overridden by a flag left in the diagnostic bag. A `||` here would
    // silently promote every such unit to SENSOR.
    const out = ignitionColumns(dto({
      ignitionKnown: false,
      rawPayload: { ignition_known: true },
    }))
    expect(out.ignitionKnown).toBe(false)
    expect(out.ignitionSource).toBe('NONE')
  })

  it('falls back to the raw payload when no explicit field is given', () => {
    // The shape the Wialon adapter has always stamped, and the same expression
    // the backfill read — so a row written now and a row filled from history
    // mean the same thing.
    expect(ignitionColumns(dto({ rawPayload: { ignition_known: true } })))
      .toMatchObject({ ignitionKnown: true, ignitionSource: 'SENSOR' })
  })

  it('treats a frame carrying neither as unknown, not as known-off', () => {
    const out = ignitionColumns(dto())
    expect(out.ignitionKnown).toBe(false)
    expect(out.ignitionSource).toBe('NONE')
    expect(out.engineHoursMeter).toBeNull()
  })

  it('keeps a zero meter reading, which is a real value', () => {
    // A brand-new unit reads 0.0 hours. Coercing that to null would discard a
    // measurement; treating null as 0 would invent one. Both directions matter
    // because dayEngineSeconds differences two of these readings.
    expect(ignitionColumns(dto({ engineHoursMeter: 0 })).engineHoursMeter).toBe(0)
    expect(ignitionColumns(dto({ rawPayload: { engine_hours: 0 } })).engineHoursMeter).toBe(0)
  })

  it('rejects a non-finite or non-numeric meter rather than storing it', () => {
    expect(ignitionColumns(dto({ rawPayload: { engine_hours: 'unknown' } })).engineHoursMeter).toBeNull()
    expect(ignitionColumns(dto({ rawPayload: { engine_hours: NaN } })).engineHoursMeter).toBeNull()
    expect(ignitionColumns(dto({ rawPayload: {} })).engineHoursMeter).toBeNull()
  })

  it('never reports METER or VOLTAGE, which were measured and rejected', () => {
    // The enum carries both because both were candidate routes. The counter
    // ticks every ~5 min against ~26 s fixes, and voltage is read live and
    // never persisted — 0 of 200,000 payloads carry it. Ingest must not name a
    // source no measurement stands behind.
    for (const raw of [{ ignition_known: true }, { ignition_known: false }, {}]) {
      expect(['SENSOR', 'NONE']).toContain(ignitionColumns(dto({ rawPayload: raw })).ignitionSource)
    }
  })
})
