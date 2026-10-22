/**
 * VSS dashcams: matching a unit to its device by the names Control Tech's
 * installers typed, reading the channel list, and the player URL.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_BASE_URL: 'https://vss.example.com', VSS_STREAM_PORT: 36301 } }
})

const { parseChannels, streamUrl } = await import('../../src/providers/vss/index.js')
const { cameraKey, matchDevice } = await import('../../src/modules/camera/camera.service.js')

const device = (deviceId: string, name: string, accessMode = 5, plate = '') =>
  ({ deviceId, name, plate, accessMode, channels: parseChannels('ROAD;IN CABIN', 2) })

describe('cameraKey', () => {
  it('reduces every spelling the installers used to one key', () => {
    for (const s of ['MUFINDI: FT 13', 'MUFINDI - FT 13', 'MUFINDI:FT 13', 'mufindi : ft13']) {
      expect(cameraKey(s)).toBe('MUFINDIFT13')
    }
  })
})

describe('matchDevice', () => {
  const devices = [
    device('867191082749044', 'MUFINDI - FT 13'),
    device('867191082725432', 'MUFINDI:LMV 20', 5, 'MUFINDI: LMV20'),
    device('867191082726463', 'MUFINDI: 26463'),
  ]

  it('finds a unit by its plate', () => {
    expect(matchDevice(devices, ['MUFINDI - FT 13', null])?.deviceId).toBe('867191082749044')
  })
  it('finds a unit by the VSS plate field when the name differs', () => {
    expect(matchDevice(devices, ['MUFINDI - LMV 20'])?.deviceId).toBe('867191082725432')
  })
  it('does not match FT 1 to FT 13', () => {
    expect(matchDevice(devices, ['MUFINDI - FT 1'])).toBeNull()
  })
  it('ignores labels too short to mean anything', () => {
    expect(matchDevice([device('1', 'FT')], ['FT', ''])).toBeNull()
  })
  it('prefers the online record when a unit has two', () => {
    const pair = [device('old', 'MUFINDI: FT 05', -1), device('new', 'MUFINDI - FT 05', 5)]
    expect(matchDevice(pair, ['MUFINDI - FT 05'])?.deviceId).toBe('new')
  })
})

describe('parseChannels', () => {
  it('keeps the names VSS has', () => {
    expect(parseChannels('ROAD;IN CABIN', 2)).toEqual([{ no: 1, name: 'ROAD' }, { no: 2, name: 'IN CABIN' }])
  })
  it('numbers channels VSS left unnamed', () => {
    expect(parseChannels(';', 2)).toEqual([{ no: 1, name: 'Channel 1' }, { no: 2, name: 'Channel 2' }])
  })
  it('falls back to the names when the count is missing', () => {
    expect(parseChannels('CH1;CH2;CH3', null)).toHaveLength(3)
  })
})

describe('streamUrl', () => {
  it("points at the VSS host's media server, as the SDK does for the central node", () => {
    expect(streamUrl()).toBe('wss://vss.example.com:36301/stream?ipaddr=127.0.0.1')
  })
})
