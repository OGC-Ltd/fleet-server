import { describe, it, expect } from 'vitest'
import { readIgnition } from '../../src/providers/wialon/wialon.sensors.js'

/**
 * Every unit in the Kasulu account names its ignition sensor "1.IGN", but they
 * are bound to five different parameters and only two of them are digital.
 * Values below are the real ones observed on the live account.
 */
const ign = (param: string) => ({ '1': { id: 1, n: '1.IGN', t: 'engine operation', p: param, m: '', f: 0, c: '' } })

describe('readIgnition — only a genuine digital line is trusted', () => {
  it('reads a real ignition input (io_239)', () => {
    expect(readIgnition(ign('io_239'), { io_239: 1 })).toBe(true)
    expect(readIgnition(ign('io_239'), { io_239: 0 })).toBe(false)
  })

  it('reads digital input 1 (io_1)', () => {
    expect(readIgnition(ign('io_1'), { io_1: 1 })).toBe(true)
    expect(readIgnition(ign('io_1'), { io_1: 0 })).toBe(false)
  })

  it('refuses io_9, which is not boolean', () => {
    // Observed live: 0, 43, 86, 87, 130, 131, 172, 174 — never 1.
    for (const v of [43, 86, 87, 130, 131, 172, 174]) {
      expect(readIgnition(ign('io_9'), { io_9: v })).toBeNull()
    }
    // 0 is still a valid "off" whatever the parameter.
    expect(readIgnition(ign('io_9'), { io_9: 0 })).toBe(false)
  })

  it('refuses pwr_ext, which is a supply voltage', () => {
    // 27.99 V on a 24 V truck — live whenever the tracker is wired in, so the
    // old `!== 0` test reported the engine permanently running.
    expect(readIgnition(ign('pwr_ext'), { pwr_ext: 27.992 })).toBeNull()
    expect(readIgnition(ign('pwr_ext'), { pwr_ext: 12.6 })).toBeNull()
  })

  it('returns null when the sensor parameter is absent and so is io_239', () => {
    expect(readIgnition(ign('flg:1'), { io_9: 131 })).toBeNull()
  })

  it('returns null when there is no ignition sensor and no io_239', () => {
    expect(readIgnition({}, { io_9: 131 })).toBeNull()
    expect(readIgnition(undefined, { pwr_ext: 27.99 })).toBeNull()
  })
})

/**
 * The precedence change, 2026-09-24.
 *
 * These four assertions replace ones that expected `null` whenever the
 * configured sensor could not be decoded. That contract left 70 of 211 KASULU
 * units permanently unreadable — and because `engineEvidence` gates the parked
 * branch, which is the only route to a SIPHON verdict, each was structurally
 * incapable of raising a fuel-theft alert. See
 * `prisma/measure-ignition-fallback.ts` and docs/fuel-theft-alerting-gaps.md.
 */
describe('readIgnition — io_239 is read ahead of the configured sensor', () => {
  it('recovers a unit whose IGN sensor is bound to a parameter it cannot decode', () => {
    // MUFINDI - FT 13: "1.IGN" -> io_9, while io_239 arrives in every message.
    expect(readIgnition(ign('io_9'), { io_9: 131, io_239: 1 })).toBe(true)
    expect(readIgnition(ign('pwr_ext'), { pwr_ext: 27.99, io_239: 0 })).toBe(false)
    // …and with no sensor configured at all.
    expect(readIgnition({}, { io_239: 1 })).toBe(true)
    expect(readIgnition(undefined, { io_239: 1 })).toBe(true)
  })

  it('prefers io_239 over a sensor reading a false OFF', () => {
    // The five live disagreements all take this shape: the sensor says off
    // while io_239 says on. A false "off" is what makes `parked` true, and
    // `parked` is what licenses a theft verdict — so the genuine line wins.
    expect(readIgnition(ign('io_1'), { io_1: 0, io_239: 1 })).toBe(true)
    // MUFINDI: MTR 14 — io_9 is not boolean, but it does take the value 0, and
    // 0 passes the binary test, so the old order reported "off" from a
    // parameter already judged untrustworthy.
    expect(readIgnition(ign('io_9'), { io_9: 0, io_239: 1 })).toBe(true)
  })

  it('leaves the 99 units where both sources agree untouched', () => {
    expect(readIgnition(ign('io_239'), { io_239: 1 })).toBe(true)
    expect(readIgnition(ign('io_1'), { io_1: 1, io_239: 1 })).toBe(true)
    expect(readIgnition(ign('io_1'), { io_1: 0, io_239: 0 })).toBe(false)
  })

  it('does not invent a reading from a non-binary io_239', () => {
    // Measured across all 211 units io_239 carries only 0 and 1, but the guard
    // must not depend on that holding for a device nobody has looked at yet.
    expect(readIgnition(ign('io_1'), { io_1: 1, io_239: 27.99 })).toBe(true)
    expect(readIgnition({}, { io_239: 174 })).toBeNull()
    expect(readIgnition({}, { io_239: '' })).toBeNull()
  })

  it('still coerces string-valued digital lines', () => {
    expect(readIgnition(ign('io_239'), { io_239: '1' })).toBe(true)
    expect(readIgnition(ign('io_239'), { io_239: '0' })).toBe(false)
  })

  it('unknown is distinct from off — the caller must be able to tell', () => {
    expect(readIgnition(ign('io_9'), { io_9: 131 })).not.toBe(false)
    expect(readIgnition(ign('io_9'), { io_9: 131 })).toBeNull()
  })
})
