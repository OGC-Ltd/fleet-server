/**
 * Moving a Planner sheet between the Deliveries reports (operator, 2026-11-21:
 * "swap a planner from FG to VS and vice versa").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
import { prismaMock } from '../helpers/prisma.mock.js'
import { setPlanList } from '../../src/modules/planner/planner.service.js'
import { planListSchema } from '../../src/modules/planner/planner.schema.js'

describe('a sheet moved between Van Sales and Finished Goods', () => {
  beforeEach(() => { prismaMock.deliveryPlan.findFirst.mockReset(); prismaMock.deliveryPlan.update.mockReset() })

  it('takes vs, fg, or null for the fleet group, and nothing else', () => {
    expect(planListSchema.parse({ list: 'vs' }).list).toBe('vs')
    expect(planListSchema.parse({ list: 'fg' }).list).toBe('fg')
    expect(planListSchema.parse({ list: null }).list).toBeNull()
    expect(() => planListSchema.parse({ list: 'van' })).toThrow()
    expect(() => planListSchema.parse({})).toThrow()
  })

  it("saves the list on this organisation's sheet", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.deliveryPlan.findFirst as any).mockResolvedValue({ id: 'p1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.deliveryPlan.update as any).mockResolvedValue({ id: 'p1', list: 'vs' })
    await expect(setPlanList('o1', 'p1', 'vs')).resolves.toEqual({ id: 'p1', list: 'vs' })
    expect(prismaMock.deliveryPlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1', organisationId: 'o1' } }))
    expect(prismaMock.deliveryPlan.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1' }, data: { list: 'vs' } }))
  })

  it("refuses another organisation's sheet", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.deliveryPlan.findFirst as any).mockResolvedValue(null)
    await expect(setPlanList('o1', 'p9', 'fg')).rejects.toThrow('Plan not found')
    expect(prismaMock.deliveryPlan.update).not.toHaveBeenCalled()
  })
})
