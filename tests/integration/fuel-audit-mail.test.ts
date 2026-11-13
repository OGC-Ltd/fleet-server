/**
 * The Fuel Audit report (operator, 2026-10-01): when an audit is done (its
 * probe repair signed off), the named roles are told — by Web Push since
 * 2026-10-28, never by mail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TEST_ORG_ID } from '../helpers/factories.js'

vi.mock('../../src/lib/prisma.js')
// Rights are read through resolveSubject since 2026-11-14; answer it from the
// role rows this file mocks (tests/helpers/roles-subject).
vi.mock('../../src/lib/authz/subject.js', async (orig) => {
  const { withRoleRowSubjects } = await import('../helpers/roles-subject.js')
  return withRoleRowSubjects(await orig<object>())
})
vi.mock('../../src/lib/queues/outbound.js', () => ({
  enqueueMail: vi.fn(async () => ({ sent: true })),
  isAccepted: vi.fn(() => true),
  dispatchStatus: vi.fn(() => 'sent'),
}))
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined) },
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { enqueueMail } from '../../src/lib/queues/outbound.js'
import { sendFuelAuditReport, auditReportRecipients, AUDIT_REPORT_ROLE_SLUGS } from '../../src/modules/fuel/fuel-audit-mail.js'
import { fuelAuditReportEmail } from '../../src/lib/mailer/templates.js'
import { pushService } from '../../src/modules/notifications/notifications.service.js'
import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'

const signedOff = new Date('2026-10-01T09:30:00Z')

function mockAudit() {
  prismaMock.organisation.findUnique.mockResolvedValue({ name: 'Mufindi' } as never)
  prismaMock.repairReportItem.findFirst.mockResolvedValue({
    stage: 'fixed', outcome: 'audit', faultKind: null, problemNote: 'Jumps around a lot',
    fixNote: 'New probe cable fitted', recommendation: 'Clip the cable away from the exhaust',
    createdAt: new Date('2026-09-30T18:36:00Z'), resolvedAt: signedOff,
    stageHistory: [{ stage: 'pending', at: '2026-09-30T18:36:00.000Z', byName: 'mufindi' }],
    expectedResolutionAt: new Date('2026-10-01T00:00:00Z'),
    vehicle: { registrationPlate: 'MUFINDI - DZ 20' },
    assignedTo: { fullName: 'controltech' }, resolvedBy: { fullName: 'controltech' },
    report: { reportedBy: { fullName: 'mufindi' } },
  } as never)
  prismaMock.fuelTheftFollowUp.findMany.mockResolvedValue([{
    status: 'PROBE_FIXED',
    theft: { stolenMl: 19400, beganAt: new Date('2026-09-30T09:49:00Z'), drainCause: null },
    actions: [{ kind: 'PROBE_FAULT', note: 'Level jumps back', at: new Date('2026-09-30T18:36:00Z'), actor: { fullName: 'Head of Security' } }],
  }] as never)
  prismaMock.repairSparePart.findMany.mockResolvedValue([{
    name: 'Probe cable', quantity: 1, supplier: 'TEST SUPPLIER', costKes: 1000, status: 'fitted',
    orderedAt: new Date('2026-09-30T19:00:00Z'), receivedAt: new Date('2026-09-30T20:00:00Z'),
    fittedAt: new Date('2026-09-30T21:00:00Z'), fixPlannedAt: new Date('2026-10-01T00:00:00Z'),
  }] as never)
  prismaMock.repairInspection.findMany.mockResolvedValue([
    { component: 'probe_cable', verdict: 'replaced', note: 'Chafed', inspectedBy: 'controltech', inspectedAt: signedOff },
  ] as never)
}

beforeEach(() => {
  vi.mocked(enqueueMail).mockClear(); vi.mocked(pushService.sendToUsers).mockClear()
  // Every account below holds notification:fuel_audit_mail through its role
  // (a right since 2026-11-14; tests/helpers/roles-subject reads these rows).
  prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'head_of_security' } }] as never)
})

describe('Fuel Audit report recipients', () => {
  it('sends to holders of notification:fuel_audit_mail on active accounts, which starts on exactly the named roles', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'HOS@x.co', fullName: 'Head' }, { id: 'u1', email: 'hos@x.co', fullName: 'Head again' }, { id: 'u2', email: 'fm@x.co', fullName: null },
    ] as never)
    const r = await auditReportRecipients(TEST_ORG_ID)
    expect(r).toEqual([{ id: 'u1', email: 'hos@x.co', name: 'Head' }, { id: 'u2', email: 'fm@x.co', name: null }])
    const where = (prismaMock.user.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where).toEqual(expect.objectContaining({ deletedAt: null, status: 'ACTIVE' }))
    expect(JSON.stringify(where)).toContain(TEST_ORG_ID)
    const holding = ROLE_DEFINITIONS.filter((d) => d.permissions.includes('notification:fuel_audit_mail')).map((d) => d.slug).sort()
    expect(holding).toEqual([...AUDIT_REPORT_ROLE_SLUGS].sort())
    expect([...AUDIT_REPORT_ROLE_SLUGS].sort()).toEqual([
      'admin', 'asst_head_of_security', 'director', 'dispatcher', 'fleet_analyst', 'fleet_manager',
      'head_of_security', 'manager', 'super_admin',
    ])
  })
})

describe('Fuel Audit report', () => {
  it('pushes the summary to every recipient when an audit is done, and mails nobody', async () => {
    mockAudit()
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u-hos', email: 'hos@x.co', fullName: 'Head' }, { id: 'u-dir', email: 'dir@x.co', fullName: 'Director' },
    ] as never)

    await sendFuelAuditReport(TEST_ORG_ID, 'ri1', ['fu1'])

    expect(enqueueMail).not.toHaveBeenCalled()
    expect(pushService.sendToUsers).toHaveBeenCalledTimes(1)
    const [ids, payload] = vi.mocked(pushService.sendToUsers).mock.calls[0]!
    expect(ids).toEqual(['u-hos', 'u-dir'])
    expect(payload.title).toBe('Fuel audit done: MUFINDI - DZ 20')
    for (const s of ['probe fixed', 'by controltech', '1 fuel alert found to be a faulty probe', 'KES 1,000', 'New probe cable fitted']) {
      expect(payload.body).toContain(s)
    }
  })

  it('sends nothing when the sign-off closed no case', async () => {
    await sendFuelAuditReport(TEST_ORG_ID, 'ri1', [])
    expect(enqueueMail).not.toHaveBeenCalled()
    expect(pushService.sendToUsers).not.toHaveBeenCalled()
  })

  it('escapes what people typed', () => {
    const html = fuelAuditReportEmail({
      orgName: 'O', plate: '<b>X</b>', verdict: 'unsuccessful', signedOffBy: null, signedOffAt: signedOff,
      fixNote: '<script>', recommendation: null,
      job: { raisedAt: signedOff, raisedBy: null, technician: null, problemNote: null, fixDate: null, stages: [] },
      alerts: [], inspections: [], parts: [],
    }).html
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>X</b>')
  })
})
