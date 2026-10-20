/**
 * The Vehicle Support and Repair Workflow's vocabulary and request bodies.
 * See docs/vehicle-support-repair-workflow-plan.md.
 *
 * The categories, queues, paths and damage classes are also CHECK constraints
 * (migration 20261020180000_repair_workflow) and a label map in new-ui
 * (src/lib/repairWorkflow.js). Adding a value means touching all three.
 */

import { z } from 'zod'
import { calendarDay } from './repairs.schema.js'

/** Telematics faults go to the ControlTech queue; the rest to the workshop. */
export const TELEMATICS = ['fuel_probe', 'tracker', 'sensor'] as const
export const MECHANICAL = [
  'engine', 'transmission', 'brakes', 'suspension_steering', 'tyres',
  'electrical', 'hydraulics', 'body',
] as const
export const FAULT_CATEGORIES = [...TELEMATICS, ...MECHANICAL, 'other'] as const
export type FaultCategory = (typeof FAULT_CATEGORIES)[number]

export type Queue = 'controltech' | 'workshop'

/** Where a category is routed. 'other' goes where the flagger says. */
export function queueFor(category: FaultCategory, chosen?: Queue): Queue {
  if ((TELEMATICS as readonly string[]).includes(category)) return 'controltech'
  if ((MECHANICAL as readonly string[]).includes(category)) return 'workshop'
  return chosen ?? 'workshop'
}

/**
 * The inspection checklist per category (plan §3.1, Q8: to be replaced by the
 * workshop's own form if it has one). It moved from a CHECK to here so it can
 * grow without a migration. The first five are today's probe components and
 * must stay as they are: existing inspection rows use them.
 */
export const CHECKLISTS: Record<FaultCategory, readonly string[]> = {
  fuel_probe:          ['probe', 'probe_cable', 'tank_bracket', 'tracker', 'calibration'],
  tracker:             ['tracker', 'antenna', 'power_feed', 'sim', 'wiring'],
  sensor:              ['sensor', 'wiring', 'connector', 'calibration'],
  engine:              ['engine', 'cooling', 'fuel_system', 'air_intake', 'exhaust'],
  transmission:        ['gearbox', 'clutch', 'driveshaft', 'differential'],
  brakes:              ['pads_shoes', 'discs_drums', 'air_hydraulic_lines', 'handbrake'],
  suspension_steering: ['springs', 'shocks', 'steering_box', 'linkages'],
  tyres:               ['tyres', 'wheels', 'hubs_bearings'],
  electrical:          ['battery', 'alternator', 'starter', 'lighting', 'wiring'],
  hydraulics:          ['pump', 'rams', 'hoses', 'valves'],
  body:                ['cab', 'body_panels', 'glass', 'trailer_coupling'],
  other:               [],
}

export const ALL_COMPONENTS = [...new Set(Object.values(CHECKLISTS).flat())]

/** The checklist a job uses. A job from before the workflow is a probe job. */
export function checklistFor(category: string | null | undefined): readonly string[] {
  return CHECKLISTS[(category ?? 'fuel_probe') as FaultCategory] ?? []
}

const note = (max = 1000) => z.string().trim().max(max)
const required = (max: number, message: string) => z.string().trim().min(1, message).max(max)

export const flagUnitsSchema = z.object({
  vehicleIds:     z.array(z.string().min(1)).min(1).max(50),
  faultCategory:  z.enum(FAULT_CATEGORIES),
  suspectedFault: required(1000, 'Say what fault you suspect'),
  /** Only read for 'other'. */
  queue:          z.enum(['controltech', 'workshop']).optional(),
  /** Off = record the flag and forward it later (it stays on 'pending'). */
  forward:        z.boolean().default(true),
})

export const pathSchema = z.object({
  path: z.enum(['remote', 'physical']),
  note: note(1000).optional(),
})

export const assessmentSchema = z.object({
  roadworthy:   z.boolean(),
  intervention: z.enum(['workshop', 'tow', 'field_inspection']),
  reason:       note(1000).optional(),
  detail: z.object({
    towProvider: note(200).optional(),
    location:    note(300).optional(),
    team:        note(300).optional(),
    note:        note(1000).optional(),
  }).optional(),
})
  .refine((a) => a.roadworthy || !!a.reason, {
    path: ['reason'], message: 'Say why the unit cannot reach the workshop',
  })
  .refine((a) => a.roadworthy === (a.intervention === 'workshop'), {
    path: ['intervention'], message: 'A roadworthy unit is driven to the workshop; an immobile one is towed or inspected on site',
  })

export const bookingSchema = z.object({
  workshopId: z.string().min(1),
  date:       calendarDay,
})

export const cancelBookingSchema = z.object({
  reason: required(500, 'Say why the booking is cancelled'),
})

export const workshopAssignSchema = z.object({
  technicianId: z.string().min(1).nullable().optional(),
  /** A mechanic with no account, named on the ticket. */
  name:         note(200).optional(),
}).refine((b) => b.technicianId || b.name, { message: 'Pick a technician or type a name' })

export const damageSchema = z.object({
  damageClass: z.enum(['genuine', 'suspected_malicious']),
  note:        note(2000).optional(),
  diagnosis:   note(4000).optional(),
}).refine((d) => d.damageClass !== 'suspected_malicious' || !!d.note, {
  path: ['note'], message: 'Describe the damage: it goes to the Head of Security',
})

export const warrantyVoidSchema = z.object({
  note:       required(1000, 'Say why the warranty is void'),
  components: z.array(z.string().min(1).max(64)).max(20).default([]),
})

export const warrantyClearSchema = z.object({
  note: required(1000, 'Say why the warranty stands'),
})

export const workEntrySchema = z.object({
  kind:          z.enum(['diagnosis', 'repair', 'test', 'note']),
  text:          required(4000, 'Write what was done'),
  labourMinutes: z.coerce.number().int().min(0).max(100_000).optional(),
})

export const completeSchema = z.object({
  testResult: z.enum(['pass', 'fail']),
  testNote:   note(2000).optional(),
  /** The account of the repair, required to complete. */
  fixNote:    required(2000, 'Say what was done'),
  recommendation: note(2000).optional(),
})

export const verifySchema = z.object({
  decision: z.enum(['accept', 'reject']),
  note:     note(1000).optional(),
}).refine((v) => v.decision === 'accept' || !!v.note, {
  path: ['note'], message: 'Say what does not match',
})

export const voidSchema = z.object({
  reason:       required(500, 'Say why this job is void'),
  precededById: z.string().min(1).optional(),
})

export const sourcePartSchema = z.object({
  status:     z.enum(['ordered', 'cancelled']),
  supplier:   note(200).optional(),
  orderRef:   note(200).optional(),
  costKes:    z.coerce.number().int().min(0).max(100_000_000).optional(),
  expectedAt: calendarDay.optional(),
  note:       note(1000).optional(),
})

export const issuePartSchema = z.object({
  store:    note(200).optional(),
  itemCode: note(100).optional(),
  issueRef: note(200).optional(),
  note:     note(1000).optional(),
})

export const investigationUpdateSchema = z.object({
  status:       z.enum(['open', 'investigating', 'closed_confirmed', 'closed_unfounded']).optional(),
  findings:     note(8000).optional(),
  assignedToId: z.string().min(1).nullable().optional(),
  note:         note(1000).optional(),
})

export const availabilityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(14),
})

export const dayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export const workshopUpdateSchema = z.object({
  name:          note(200).optional(),
  dailyCapacity: z.coerce.number().int().min(0).max(100).optional(),
  location:      note(300).optional(),
})

export type FlagUnits     = z.infer<typeof flagUnitsSchema>
export type PathBody      = z.infer<typeof pathSchema>
export type Assessment    = z.infer<typeof assessmentSchema>
export type Booking       = z.infer<typeof bookingSchema>
export type WorkshopAssign = z.infer<typeof workshopAssignSchema>
export type Damage        = z.infer<typeof damageSchema>
export type WarrantyVoid  = z.infer<typeof warrantyVoidSchema>
export type WorkEntry     = z.infer<typeof workEntrySchema>
export type Complete      = z.infer<typeof completeSchema>
export type Verify        = z.infer<typeof verifySchema>
export type VoidBody      = z.infer<typeof voidSchema>
export type SourcePart    = z.infer<typeof sourcePartSchema>
export type IssuePart     = z.infer<typeof issuePartSchema>
export type InvestigationUpdate = z.infer<typeof investigationUpdateSchema>
