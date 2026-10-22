/**
 * A unit's dashcam: which VSS device it carries, its channels, whether it is
 * online, and the media server the dashboard's player streams from
 * (providers/vss). No VSS token leaves the server.
 *
 * ## How a unit finds its device
 *
 * VSS knows nothing of our ids. Its device record has a name and, sometimes, a
 * plate, typed by Control Tech's installers: "MUFINDI: FT 13", "MUFINDI - BUS
 * 03", "MUFINDI:FT 10". Our plate for the same truck is "MUFINDI - FT 13". So
 * both sides are reduced to letters and digits, upper-cased, and compared:
 * MUFINDIFT13 = MUFINDIFT13. The org prefix stays in the key on purpose — "FT
 * 13" alone would be ambiguous across tenants.
 *
 * Measured 2026-10-22: 129 devices, all Mufindi; 52 carry a fleet number and
 * match this way, and 77 are named only by the tail of their IMEI ("MUFINDI:
 * 26463"). Those 77 cannot be matched from anything VSS holds; they light up
 * when Control Tech names them in VSS, with no change here.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { listDevices, liveStatus, streamUrl, vssAvailable, type VssDevice } from '../../providers/vss/index.js'

export type CameraState =
  /** VSS credentials are not set on this server. */
  | 'not_configured'
  /** No VSS device carries this unit's plate or name. */
  | 'no_camera'
  /** The device exists and VSS says it is not connected. */
  | 'offline'
  /** The device is connected; the player can open `streamUrl`. */
  | 'live'
  /** VSS itself did not answer. */
  | 'unavailable'

export interface VehicleCamera {
  state:    CameraState
  deviceId: string | null
  /** The device's name in VSS, so an operator can find it there. */
  deviceName: string | null
  channels: { no: number; name: string }[]
  /** Where the player connects, when `state` is live: VSS's media server. */
  streamUrl: string | null
  message:  string | null
}

/** "MUFINDI: FT 13" → "MUFINDIFT13". */
export function cameraKey(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * The device for a unit known by these labels. More than one match (a box
 * swapped and the old record left behind) prefers the one that is online.
 */
export function matchDevice(devices: VssDevice[], labels: (string | null | undefined)[]): VssDevice | null {
  const keys = new Set(labels.map(cameraKey).filter(k => k.length >= 4))
  if (keys.size === 0) return null
  const hits = devices.filter(d => keys.has(cameraKey(d.name)) || keys.has(cameraKey(d.plate)))
  return hits.find(d => d.accessMode >= 1) ?? hits[0] ?? null
}

const empty = (state: CameraState, message: string | null): VehicleCamera =>
  ({ state, deviceId: null, deviceName: null, channels: [], streamUrl: null, message })

export async function getVehicleCamera(orgId: string, vehicleId: string): Promise<VehicleCamera> {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { registrationPlate: true, name: true },
  })
  if (!vehicle) throw new NotFoundError('Vehicle not found')
  return cameraFor([vehicle.registrationPlate, vehicle.name], vehicleId)
}

/** The camera for a unit known by these labels (its plate and name). */
export async function cameraFor(labels: (string | null)[], vehicleId: string): Promise<VehicleCamera> {
  if (!vssAvailable()) return empty('not_configured', 'The camera service is not set up on this server.')

  let device: VssDevice | null
  try {
    device = matchDevice(await listDevices(), labels)
  } catch (err) {
    logger.warn({ err, vehicleId }, 'vss: device list failed')
    return empty('unavailable', 'The camera service is not answering. Try again in a minute.')
  }
  if (!device) return empty('no_camera', null)

  const base = { deviceId: device.deviceId, deviceName: device.name || device.plate, channels: device.channels }
  let accessMode: number
  try {
    accessMode = await liveStatus(device.deviceId)
  } catch (err) {
    logger.warn({ err, vehicleId, deviceId: device.deviceId }, 'vss: status failed')
    return { ...base, state: 'unavailable', streamUrl: null, message: 'The camera service is not answering. Try again in a minute.' }
  }

  if (accessMode < 1) {
    return { ...base, state: 'offline', streamUrl: null, message: 'The camera is not connected to the video server.' }
  }
  return { ...base, state: 'live', streamUrl: streamUrl(), message: null }
}
