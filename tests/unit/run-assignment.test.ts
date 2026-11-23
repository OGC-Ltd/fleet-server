import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))

import { linkRun, type RunLink } from '../../src/modules/vehicles/run-assignment.js'
import { assignmentAt } from '../../src/modules/vehicles/driver-assignment.js'

// An in-memory stand-in for the two tables, answering only the filters
// run-assignment uses.
type Row = Record<string, unknown> & { id: string }
type Where = Record<string, unknown>

const cmp = (v: unknown, f: unknown): boolean => {
  if (f === null || f instanceof Date || typeof f !== 'object') {
    return f instanceof Date ? v instanceof Date && v.getTime() === f.getTime() : v === f
  }
  const o = f as Record<string, unknown>
  if ('gt' in o && !(v instanceof Date && v > (o.gt as Date))) return false
  if ('lt' in o && !(v instanceof Date && v < (o.lt as Date))) return false
  if ('startsWith' in o && !(typeof v === 'string' && v.startsWith(o.startsWith as string))) return false
  if ('not' in o && v === o.not) return false
  return true
}
const match = (r: Row, w: Where): boolean => Object.entries(w).every(([k, f]) =>
  k === 'OR' ? (f as Where[]).some(x => match(r, x)) : cmp(r[k], f))
const pick = <T extends Row>(rows: T[], w: Where, by?: string) => {
  const hit = rows.filter(r => match(r, w))
  if (by) hit.sort((a, b) => (a[by] as Date).getTime() - (b[by] as Date).getTime())
  return hit[0] ?? null
}

function fakeDb(dispatches: Row[] = []) {
  const rows: Row[] = []
  let n = 0
  const db = {
    vehicleAssignment: {
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const hit = rows.filter(r => match(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }
      },
      findFirst: async ({ where, orderBy }: { where: Where; orderBy?: Record<string, string> }) =>
        pick(rows, where, orderBy ? Object.keys(orderBy)[0] : undefined),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(rows.find(r => r.id === where.id)!, data),
      create: async ({ data }: { data: Row }) => { const r = { ...data, id: `a${++n}` }; rows.push(r); return r },
    },
    dispatch: {
      findFirst: async ({ where, orderBy }: { where: Where; orderBy?: Record<string, string> }) =>
        pick(dispatches, where, orderBy ? Object.keys(orderBy)[0] : undefined),
    },
  }
  return { db: db as never, rows, dispatches }
}

const d = (iso: string) => new Date(iso)
const run = (id: string, userId: string | null, start: string, back: string | null, cancelled = false): RunLink => ({
  vehicleId: 'v1', userId, marker: `controltech:dispatch:${id}`, externalId: id,
  startedAt: d(start), returnedAt: back ? d(back) : null, cancelled,
})
const dispatch = (id: string, at: string, status = 'COMPLETED'): Row =>
  ({ id, externalId: id, vehicleId: 'v1', dispatchedAt: d(at), status })

describe('linkRun: a driver keeps the truck until its next dispatch', () => {
  it('the sign-in is recorded but does not unlink the driver', async () => {
    const { db, rows } = fakeDb([dispatch('1', '2026-11-22T06:00:00Z')])
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: 'ann', unassignedAt: null, returnedAt: d('2026-11-22T18:00:00Z') })
    expect(assignmentAt(rows as never[], d('2026-11-23T05:00:00Z'))).toMatchObject({ userId: 'ann' })
  })

  it('the next dispatch ends it, at the moment that run starts', async () => {
    const { db, rows, dispatches } = fakeDb([dispatch('1', '2026-11-22T06:00:00Z')])
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    dispatches.push(dispatch('2', '2026-11-23T07:00:00Z', 'DISPATCHED'))
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null), db)
    const [ann, bob] = rows
    expect(ann).toMatchObject({ unassignedAt: d('2026-11-23T07:00:00Z'), returnedAt: d('2026-11-22T18:00:00Z') })
    expect(bob).toMatchObject({ userId: 'bob', unassignedAt: null })
  })

  it('a next run whose driver does not resolve still takes the truck', async () => {
    const { db, rows } = fakeDb()
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    await linkRun(run('2', null, '2026-11-23T07:00:00Z', null), db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.unassignedAt).toEqual(d('2026-11-23T07:00:00Z'))
  })

  it('re-reading the same run on a reconcile pass changes nothing', async () => {
    const { db, rows } = fakeDb()
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', null), db)
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null), db)
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null), db)
    expect(rows.map(r => r.unassignedAt)).toEqual([d('2026-11-23T07:00:00Z'), null])
    expect(rows[0]!.returnedAt).toEqual(d('2026-11-22T18:00:00Z'))
  })

  it('an older run read late is closed by the newer one already on record', async () => {
    const { db, rows, dispatches } = fakeDb([dispatch('2', '2026-11-23T07:00:00Z')])
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null), db)
    dispatches.push(dispatch('1', '2026-11-22T06:00:00Z'))
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    expect(rows.find(r => r.userId === 'ann')!.unassignedAt).toEqual(d('2026-11-23T07:00:00Z'))
    expect(rows.find(r => r.userId === 'bob')!.unassignedAt).toBeNull()
  })

  it('a cancelled run holds nothing and gives the truck back', async () => {
    const { db, rows, dispatches } = fakeDb([dispatch('1', '2026-11-22T06:00:00Z')])
    await linkRun(run('1', 'ann', '2026-11-22T06:00:00Z', '2026-11-22T18:00:00Z'), db)
    dispatches.push(dispatch('2', '2026-11-23T07:00:00Z', 'DISPATCHED'))
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null), db)
    dispatches[1]!.status = 'CANCELLED'
    await linkRun(run('2', 'bob', '2026-11-23T07:00:00Z', null, true), db)
    const [ann, bob] = rows
    expect(ann!.unassignedAt).toBeNull()
    expect(bob!.unassignedAt).toEqual(bob!.assignedAt)
    expect(assignmentAt(rows as never[], d('2026-11-23T09:00:00Z'))).toMatchObject({ userId: 'ann' })
  })
})
