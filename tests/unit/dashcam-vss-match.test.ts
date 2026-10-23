/**
 * Pairing VSS devices with our vehicles, for the live camera and the Alarms
 * tab. The installers name devices two ways: "MUFINDI: FT 13" (our plate
 * "MUFINDI - FT 13") and "SUKARI - KDR 430Q" (our plate "KDR 430Q").
 */

import { describe, it, expect } from 'vitest'
import { matchDevice, registrationTail, devicePrefix } from '../../src/modules/dashcam/vss-match.js'

const dev = (deviceId: string, name: string, plate = '', accessMode = 1) => ({ deviceId, name, plate, accessMode })
const DEVICES = [
  dev('1', 'SUKARI - KDR 430Q'), dev('2', 'AQUAMIST - KAV 274M'), dev('3', 'MUFINDI: FT 13'), dev('4', 'OTHER - FT 13'),
  dev('5', 'MUFINDI - BUS 03'), dev('6', 'AQUAMIST:KAT 404S'), dev('7', 'MUFINDI: 26463'), dev('8', 'KCA 123B'),
]

describe('registrationTail / devicePrefix', () => {
  it('reads the registration after the organisation prefix', () => {
    expect(registrationTail('SUKARI - KDR 430Q')).toBe('KDR430Q')
    expect(registrationTail('AQUAMIST:KAT 404S')).toBe('KAT404S')
  })
  it('does not take a bare fleet number or an IMEI tail on its own', () => {
    expect(registrationTail('MUFINDI: FT 13')).toBeNull()
    expect(registrationTail('MUFINDI: 26463')).toBeNull()
    expect(registrationTail('KCA 123B')).toBeNull()
  })
  it('names the organisation part', () => {
    expect(devicePrefix('SUKARI - KDR 430Q')).toBe('SUKARI')
    expect(devicePrefix('MUFINDI:FT 13')).toBe('MUFINDI')
    expect(devicePrefix('KCA123B')).toBeNull()
  })
})

describe('matchDevice', () => {
  const cases: [string[], string | null][] = [
    [['KDR 430Q', 'Tipper'], '1'],
    [['KAV 274M'], '2'],
    [['MUFINDI - FT 13'], '3'],
    [['FT 13'], null],                // ambiguous across organisations: never matched
    [['MUFINDI BUS 03'], '5'],
    [['KAT404S'], '6'],
    [['26463'], null],
    [['KCA 123B'], '8'],
    [['SUKARI - KDR 430Q'], '1'],
    [['KDR 999Z'], null],
  ]
  for (const [labels, want] of cases) {
    it(`${JSON.stringify(labels)} → ${want}`, () => {
      expect(matchDevice(DEVICES, labels)?.deviceId ?? null).toBe(want)
    })
  }
})
