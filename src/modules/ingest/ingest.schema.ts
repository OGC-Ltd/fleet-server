import { z } from 'zod'

/** Normalised telemetry payload accepted by POST /api/v1/ingest/telemetry.
 *  Vendor-specific adapters transform raw packets into this shape before forwarding. */
export const telemetryPayloadSchema = z.object({
  deviceId:       z.string().min(1).max(100),
  capturedAt:     z.coerce.date(),
  lat:            z.number().min(-90).max(90).optional(),
  lng:            z.number().min(-180).max(180).optional(),
  altitudeM:      z.number().optional(),
  headingDeg:     z.number().min(0).max(360).optional(),
  accuracyM:      z.number().nonnegative().optional(),
  speedKmh:       z.number().nonnegative().optional(),
  engineOn:       z.boolean().optional(),
  /** Was engineOn measured, or inferred from speed? Absent is treated as unknown. */
  ignitionKnown:  z.boolean().optional(),
  /** Cumulative engine-hours counter at this fix, in hours — absolute, not a delta. */
  engineHoursMeter: z.number().nonnegative().optional(),
  /**
   * Accelerometer axes at this fix, in g, from the same message as the
   * position. ±16 g is the most a tracker accelerometer reports.
   */
  accelXG:        z.number().min(-16).max(16).optional(),
  accelYG:        z.number().min(-16).max(16).optional(),
  accelZG:        z.number().min(-16).max(16).optional(),
  /** Supply voltages at this fix, volts: the vehicle's electrics and the tracker's own battery. */
  extVoltageV:    z.number().min(0).max(60).optional(),
  intVoltageV:    z.number().min(0).max(60).optional(),
  fuelLevelMl:    z.number().int().nonnegative().optional(),
  fuelUsedMl:     z.number().int().optional(),
  cargoWeightKg:  z.number().nonnegative().optional(),

  /**
   * On-board camera state, where the unit has a recorder.
   *
   * Optional and absent on essentially every payload — one unit of 1,496 in
   * this Wialon account has a camera. `cameraStreamUrl` is a URL only: the
   * provider adapter drops anything that does not parse as http(s), so a value
   * arriving here is always something a browser can open. Validated again
   * anyway, because ingest is a public boundary and the adapter is not the only
   * possible caller.
   */
  cameraFitted:     z.boolean().optional(),
  cameraStreamUrl:  z.string().url().max(2048).optional(),
  cameraRecording:  z.boolean().optional(),
  cameraSignalLost: z.boolean().optional(),
  rawPayload:     z.record(z.string(), z.unknown()).optional(),
})

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>
