/**
 * The Ops Room Operator and the Gate log (2026-11-25): sign-outs and returns
 * only, view only, and nothing else opened, for this role or any other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const reader = vi.hoisted(() => ({ calls: [] as unknown[], items: [] as Array<Record<string, unknown>> }))
vi.mock('../../src/lib/notifications/notification.reader.js', () => ({
  getNotifications: vi.fn(async (orgId: string, q: unknown) => { reader.calls.push([orgId, q]); return { items: reader.items, source: 'database' } }),
}))
const org = vi.hoisted(() => ({ row: null as null | Record<string, unknown>, fail: false }))
const ack = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>, fail: false,
  event: null as null | Record<string, unknown>,
  upserts: [] as Array<Record<string, any>>,
}))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    organisation: { findUnique: vi.fn(async () => { if (org.fail) throw new Error('db down'); return org.row }) },
    gateAcknowledgement: {
      findMany: vi.fn(async () => { if (ack.fail) throw new Error('db down'); return ack.rows }),
      upsert: vi.fn(async (q: Record<string, any>) => {
        ack.upserts.push(q)
        return { eventId: q.where.organisationId_eventId.eventId, outcome: q.update.outcome, note: q.update.note, decidedByName: q.update.decidedByName, decidedAt: q.update.decidedAt }
      }),
    },
    notification: { findUnique: vi.fn(async () => ack.event) },
    user: { findUnique: vi.fn(async () => ({ fullName: 'Achieng Otieno' })) },
  },
}))

const { gateLog, acknowledge, GATE_LOG_ALERT_TYPES } = await import('../../src/modules/gate-log/gate-log.controller.js')
const { ROLE_DEFINITIONS, ASSIGNABLE_ROLE_SLUGS, PERMISSION_CATALOGUE } = await import('../../src/lib/permissions.js')

const item = (alertType: string, ts: string) => ({ id: ts, ts, time: '', type: 'info', text: `${alertType} at ${ts}`, source: 'factorysuite', alertType, plate: 'KDA 001A', vehicleId: null })
function call(query: Record<string, string> = {}, authz: unknown = { vehicleIds: null }) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, json(b: unknown) { this.body = b; return this } }
  return gateLog({ params: { orgId: 'org_1' }, query, authz } as never, res as never).then(() => res)
}

beforeEach(() => {
  reader.calls = []; reader.items = []; org.row = null; org.fail = false
  ack.rows = []; ack.fail = false; ack.event = null; ack.upserts = []
})

describe('the Gate log route', () => {
  it('asks only for the gate’s four types, whatever the query says', async () => {
    await call({ alertType: 'SPEEDING', day: '2026-11-25' })
    const [orgId, q] = reader.calls[0] as [string, Record<string, unknown>]
    expect(orgId).toBe('org_1')
    expect(q['alertTypes']).toEqual(['DISPATCH', 'MOVEMENT_ENTRY', 'SALE_DISPATCH', 'SALE_RETURN'])
    expect(q['day']).toBe('2026-11-25')
    expect(q['grants']).toEqual([])
    expect(GATE_LOG_ALERT_TYPES).not.toContain('MOVEMENT_EXIT')
  })

  it('lets nothing else out, even if the reader returned it', async () => {
    reader.items = [item('DISPATCH', '2026-11-25T08:00:00Z'), item('FUEL_DRAIN', '2026-11-25T07:00:00Z'), item('SALE_RETURN', '2026-11-25T06:00:00Z')]
    const res = await call()
    const body = res.body as { data?: { events: Array<{ alertType: string }> }; events?: Array<{ alertType: string }> }
    const events = (body.data ?? body).events!
    expect(events.map((e) => e.alertType)).toEqual(['DISPATCH', 'SALE_RETURN'])
  })

  it('gives the next cursor whenever the page had lines, even a short one, and none at the end', async () => {
    reader.items = [item('DISPATCH', '2026-11-25T08:00:00Z'), item('MOVEMENT_ENTRY', '2026-11-25T07:00:00Z')]
    const body = (await call({ limit: '200' })).body as { data?: { nextBefore: string | null }; nextBefore?: string | null }
    expect((body.data ?? body).nextBefore).toBe('2026-11-25T07:00:00Z')
    reader.items = []
    const end = (await call()).body as { data?: { nextBefore: string | null }; nextBefore?: string | null }
    expect((end.data ?? end).nextBefore).toBeNull()
  })

  it('keeps the caller’s vehicle scope, checks the day and caps the page', async () => {
    const scope = new Set(['v1'])
    await call({ limit: '5000' }, { vehicleIds: scope })
    const q = (reader.calls[0] as [string, Record<string, unknown>])[1]
    expect(q['vehicleIds']).toBe(scope)
    expect(q['limit']).toBe(200)
    expect((await call({ day: '25/11/2026' })).statusCode).toBe(400)
    expect((await call({ before: 'yesterday' })).statusCode).toBe(400)
  })
})

describe('the Ops Room Operator role', () => {
  const role = ROLE_DEFINITIONS.find((r) => r.slug === 'ops_room_operator')!

  it('exists in every organisation and can be handed out by an organisation admin', () => {
    expect(role).toMatchObject({ name: 'Ops Room Operator', platform: false })
    expect(ASSIGNABLE_ROLE_SLUGS).toContain('ops_room_operator')
    expect(PERMISSION_CATALOGUE).toHaveProperty('gate_log:read')
  })

  it('opens the Gate log and the weighbridges, and not the live feed, the map, alerts, reports or administration', () => {
    for (const p of ['gate_log:read', 'weighbridge:read', 'vehicle:read', 'telemetry:read']) expect(role.permissions).toContain(p)
    for (const p of ['notification:read', 'map:read', 'alerts:read', 'dashboard:read', 'report:read', 'analytics:read', 'driver:read', 'fuel_filling:read', 'repair:read', 'user:create', 'role:read']) {
      expect(role.permissions).not.toContain(p)
    }
  })

  it('acts on nothing but the gate: acknowledging its events is its one right to act', () => {
    const acting = role.permissions.filter((p) => /:(create|update|delete|write|assign|decide|resolve|flag|verify|book|assess|export|acknowledge)$/.test(p) || p.startsWith('notification:push'))
    expect(acting).toEqual(['gate_log:acknowledge'])
  })

  it('only Admin was given the Gate log besides it, and Admin keeps the live feed (so no pop-ups)', () => {
    expect(ROLE_DEFINITIONS.filter((r) => r.permissions.includes('gate_log:read')).map((r) => r.slug).sort()).toEqual(['admin', 'ops_room_operator'])
    expect(ROLE_DEFINITIONS.find((r) => r.slug === 'admin')!.permissions).toContain('notification:read')
    expect(ROLE_DEFINITIONS.filter((r) => r.permissions.includes('gate_log:acknowledge')).map((r) => r.slug).sort()).toEqual(['admin', 'ops_room_operator'])
    expect(PERMISSION_CATALOGUE).toHaveProperty('gate_log:acknowledge')
  })
})

describe('the gate on the Gate log route (event panel map, 2026-11-26)', () => {
  const gateOf = async () => { const res = await call({ day: '2026-11-26' }); const body = res.body as { data?: { gate?: unknown } }; return (body.data ?? body as { gate?: unknown }).gate }
  it('sends the organisation gate, with its radius or the 60 m default', async () => {
    org.row = { gateLat: -0.8, gateLng: 34.4, gateRadiusM: 45 }
    expect(await gateOf()).toEqual({ lat: -0.8, lng: 34.4, radiusM: 45 })
    org.row = { gateLat: -0.8, gateLng: 34.4, gateRadiusM: null }
    expect(await gateOf()).toEqual({ lat: -0.8, lng: 34.4, radiusM: 60 })
  })
  it('sends null where no gate is recorded or the read fails, and still lists the day', async () => {
    reader.items = [item('DISPATCH', '2026-11-26T05:00:00Z')]
    org.row = { gateLat: null, gateLng: 34.4, gateRadiusM: null }
    expect(await gateOf()).toBeNull()
    org.fail = true
    const res = await call({ day: '2026-11-26' })
    expect(res.statusCode).toBe(200)
    const body = res.body as { data?: { gate?: unknown; events?: unknown[] } }
    expect((body.data ?? body as { gate?: unknown; events?: unknown[] }).gate).toBeNull()
    expect((body.data ?? body as { events?: unknown[] }).events).toHaveLength(1)
  })
})

describe('acknowledging a gate event (2026-11-26)', () => {
  const dataOf = (res: { body: unknown }) => { const b = res.body as { data?: any }; return b.data ?? b }
  function post(body: unknown, { eventId = 'dp-1', authz = { vehicleIds: null } as unknown, user = { id: 'u1' } as unknown } = {}) {
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, json(b: unknown) { this.body = b; return this } }
    return acknowledge({ params: { orgId: 'org_1', eventId }, body, authz, user } as never, res as never).then(() => res)
  }
  const gateEvent = { organisationId: 'org_1', alertType: 'DISPATCH', vehicleId: 'v1', plate: 'KDA 001A', occurredAt: new Date('2026-11-26T05:00:00Z') }

  it('lists each event with its acknowledgement, or null', async () => {
    reader.items = [item('DISPATCH', '2026-11-26T06:00:00Z'), item('MOVEMENT_ENTRY', '2026-11-26T05:00:00Z')]
    ack.rows = [{ eventId: '2026-11-26T06:00:00Z', outcome: 'CONFIRMED', note: null, decidedByName: 'Achieng Otieno', decidedAt: new Date('2026-11-26T07:00:00Z') }]
    const { events } = dataOf(await call({ day: '2026-11-26' }))
    expect(events.map((e: any) => e.acknowledgement)).toEqual([
      { outcome: 'CONFIRMED', note: null, by: 'Achieng Otieno', at: '2026-11-26T07:00:00.000Z' },
      null,
    ])
  })

  it('still lists the day when the acknowledgements cannot be read, without them', async () => {
    reader.items = [item('DISPATCH', '2026-11-26T06:00:00Z')]
    ack.fail = true
    const res = await call({ day: '2026-11-26' })
    expect(res.statusCode).toBe(200)
    expect(dataOf(res).events[0]).not.toHaveProperty('acknowledgement')
  })

  it('saves a confirmation with who and when, keyed on the event', async () => {
    ack.event = gateEvent
    const res = await post({ outcome: 'CONFIRMED' })
    expect(res.statusCode).toBe(200)
    expect(dataOf(res).acknowledgement).toMatchObject({ outcome: 'CONFIRMED', note: null, by: 'Achieng Otieno' })
    const q = ack.upserts[0]!
    expect(q.where).toEqual({ organisationId_eventId: { organisationId: 'org_1', eventId: 'dp-1' } })
    expect(q.create).toMatchObject({ alertType: 'DISPATCH', vehicleId: 'v1', plate: 'KDA 001A', decidedById: 'u1' })
  })

  it('wants a reason to dispute, and a known outcome', async () => {
    ack.event = gateEvent
    expect((await post({ outcome: 'DISPUTED', note: ' ' })).statusCode).toBe(400)
    expect((await post({ outcome: 'MAYBE' })).statusCode).toBe(400)
    expect((await post({ outcome: 'DISPUTED', note: 'Still parked in the yard' })).statusCode).toBe(200)
    expect(ack.upserts[0]!.update.note).toBe('Still parked in the yard')
  })

  it('finds no event that is another organisation\'s, not the gate\'s, or outside the caller\'s units', async () => {
    ack.event = null
    expect((await post({ outcome: 'CONFIRMED' })).statusCode).toBe(404)
    ack.event = { ...gateEvent, organisationId: 'org_2' }
    expect((await post({ outcome: 'CONFIRMED' })).statusCode).toBe(404)
    ack.event = { ...gateEvent, alertType: 'SPEEDING' }
    expect((await post({ outcome: 'CONFIRMED' })).statusCode).toBe(404)
    ack.event = gateEvent
    expect((await post({ outcome: 'CONFIRMED' }, { authz: { vehicleIds: new Set(['v9']) } })).statusCode).toBe(404)
    expect((await post({ outcome: 'CONFIRMED' }, { authz: { vehicleIds: new Set(['v1']) } })).statusCode).toBe(200)
    expect(ack.upserts).toHaveLength(1)
  })

  it('wants an account', async () => {
    ack.event = gateEvent
    expect((await post({ outcome: 'CONFIRMED' }, { user: null })).statusCode).toBe(401)
  })
})
