import { z } from 'zod'

// One unit's line on the client's fleet list, as the page reads it off the
// Excel file (new-ui lib/fleetListFile): only plate, driver, status, TYPE and
// the sheet it is on. ID and phone numbers never leave the file.
const text = (max: number) => z.string().trim().max(max)
const entrySchema = z.object({
  driver: text(160).default(''),
  status: text(60).default(''),
  type:   text(60).default(''),
  list:   text(120).default(''),
}).strip()

/** POST /organisations/:orgId/fleet-list: a fleet Excel as the page read it. */
export const saveFleetListSchema = z.object({
  fileName:  text(200).min(1),
  entries:   z.record(text(32).min(1), entrySchema)
    .refine((e) => Object.keys(e).length > 0, 'The file has no units')
    .refine((e) => Object.keys(e).length <= 5000, 'At most 5000 units'),
  sheets:    z.array(z.object({ name: text(120), count: z.number().int().min(0) })).max(100).default([]),
  conflicts: z.array(z.object({ plate: text(32), kept: text(120), also: text(120) })).max(5000).default([]),
})
export type SaveFleetList = z.infer<typeof saveFleetListSchema>
