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
  fuelLevelMl:    z.number().int().nonnegative().optional(),
  fuelUsedMl:     z.number().int().optional(),
  cargoWeightKg:  z.number().nonnegative().optional(),
  rawPayload:     z.record(z.string(), z.unknown()).optional(),
})

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>
