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

  it('returns null when the parameter is absent (flg:1 is not in `p`)', () => {
    expect(readIgnition(ign('flg:1'), { io_239: 1 })).toBeNull()
  })

  it('returns null when there is no ignition sensor at all', () => {
    expect(readIgnition({}, { io_239: 1 })).toBeNull()
    expect(readIgnition(undefined, { io_239: 1 })).toBeNull()
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
