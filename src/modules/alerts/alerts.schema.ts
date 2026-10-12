import { z } from 'zod'

/** A comma-separated list in one query parameter, e.g. `orgs=a,b`. */
const idList = z.string().max(2000).optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))

/** GET /api/v1/alerts. With no `from`/`to`, the last 7 days. */
export const listAlertsQuery = z.object({
  kind: z.enum(['all', 'fuel', 'speeding']).default('all'),
  status: z.enum(['open', 'escalated', 'deescalated', 'all']).default('open'),
  /** Organisation ids; empty means every one this person may read. */
  orgs: idList,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Plate or unit name, part of either. */
  q: z.string().trim().max(64).optional(),
  /** Speeding only: episodes at least this far over their limit. */
  minOverKmh: z.coerce.number().min(0).max(300).optional(),
  /** This person's read marks: unread only, read only, or both. */
  read: z.enum(['all', 'read', 'unread']).default('all'),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ListAlertsQuery = z.infer<typeof listAlertsQuery>

/** Escalating or de-escalating an overspeeding episode. The note is required:
 *  a decision with no reason on record cannot be reviewed later. */
export const reviewSpeedingSchema = z.object({
  outcome: z.enum(['ESCALATED', 'DEESCALATED']),
  note: z.string().trim().min(3).max(2000),
})
export type ReviewSpeedingDto = z.infer<typeof reviewSpeedingSchema>

/** Alerts this person has read: opened, or decided, on the Alerts page. */
export const markReadSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(['fuel', 'speeding']),
    id: z.string().min(1).max(64),
  })).min(1).max(200),
})
export type MarkReadDto = z.infer<typeof markReadSchema>
