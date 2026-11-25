/**
 * The Ops Room Operator and the Gate log (2026-11-25): sign-outs and returns
 * only, view only, and nothing else opened, for this role or any other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const reader = vi.hoisted(() => ({ calls: [] as unknown[], items: [] as Array<Record<string, unknown>> }))
vi.mock('../../src/lib/notifications/notification.reader.js', () => ({
  getNotifications: vi.fn(async (orgId: string, q: unknown) => { reader.calls.push([orgId, q]); return { items: reader.items, source: 'database' } }),
}))

const { gateLog, GATE_LOG_ALERT_TYPES } = await import('../../src/modules/gate-log/gate-log.controller.js')
const { ROLE_DEFINITIONS, ASSIGNABLE_ROLE_SLUGS, PERMISSION_CATALOGUE } = await import('../../src/lib/permissions.js')

const item = (alertType: string, ts: string) => ({ id: ts, ts, time: '', type: 'info', text: `${alertType} at ${ts}`, source: 'factorysuite', alertType, plate: 'KDA 001A', vehicleId: null })
function call(query: Record<string, string> = {}, authz: unknown = { vehicleIds: null }) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, json(b: unknown) { this.body = b; return this } }
  return gateLog({ params: { orgId: 'org_1' }, query, authz } as never, res as never).then(() => res)
}

beforeEach(() => { reader.calls = []; reader.items = [] })

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

  it('is view only: no right to create, change, delete, decide or assign anything', () => {
    const acting = role.permissions.filter((p) => /:(create|update|delete|write|assign|decide|resolve|flag|verify|book|assess|export)$/.test(p) || p.startsWith('notification:push'))
    expect(acting).toEqual([])
  })

  it('no other role was given the Gate log', () => {
    expect(ROLE_DEFINITIONS.filter((r) => r.permissions.includes('gate_log:read')).map((r) => r.slug)).toEqual(['ops_room_operator'])
  })
})
