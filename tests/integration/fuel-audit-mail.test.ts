/**
 * The Fuel Audit report mail (operator, 2026-10-01): when an audit is done
 * (its probe repair signed off), the full report goes to the named roles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TEST_ORG_ID } from '../helpers/factories.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/queues/outbound.js', () => ({
  enqueueMail: vi.fn(async () => ({ sent: true })),
  isAccepted: vi.fn(() => true),
  dispatchStatus: vi.fn(() => 'sent'),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { enqueueMail } from '../../src/lib/queues/outbound.js'
import { sendFuelAuditReport, auditReportRecipients, AUDIT_REPORT_ROLE_SLUGS } from '../../src/modules/fuel/fuel-audit-mail.js'
import { fuelAuditReportEmail } from '../../src/lib/mailer/templates.js'

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

beforeEach(() => { vi.mocked(enqueueMail).mockClear() })

describe('Fuel Audit report recipients', () => {
  it('asks for live grants of exactly the named roles, here or platform-wide, on active accounts', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { email: 'HOS@x.co', fullName: 'Head' }, { email: 'hos@x.co', fullName: 'Head again' }, { email: 'fm@x.co', fullName: null },
    ] as never)
    const r = await auditReportRecipients(TEST_ORG_ID)
    expect(r).toEqual([{ email: 'hos@x.co', name: 'Head' }, { email: 'fm@x.co', name: null }])
    const where = (prismaMock.user.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where).toEqual(expect.objectContaining({ deletedAt: null, status: 'ACTIVE' }))
    expect(JSON.stringify(where)).toContain(TEST_ORG_ID)
    expect([...AUDIT_REPORT_ROLE_SLUGS].sort()).toEqual([
      'admin', 'asst_head_of_security', 'director', 'dispatcher', 'fleet_analyst', 'fleet_manager',
      'head_of_security', 'manager', 'super_admin',
    ])
  })
})

describe('Fuel Audit report mail', () => {
  it('mails every recipient the full report when an audit is done', async () => {
    mockAudit()
    prismaMock.user.findMany.mockResolvedValue([{ email: 'hos@x.co', fullName: 'Head' }, { email: 'dir@x.co', fullName: 'Director' }] as never)

    await sendFuelAuditReport(TEST_ORG_ID, 'ri1', ['fu1'])

    expect(enqueueMail).toHaveBeenCalledTimes(2)
    const mail = vi.mocked(enqueueMail).mock.calls[0]![2]
    expect(mail.subject).toBe('[Mufindi] Fuel Audit done — MUFINDI - DZ 20 · Probe repaired')
    for (const s of ['Jumps around a lot', 'New probe cable fitted', 'Clip the cable away', 'Probe cable', 'TEST SUPPLIER',
      'KES 1,000', 'Found to be a faulty probe', 'Head of Security', '19.4 L', 'controltech', 'Chafed']) {
      expect(mail.text).toContain(s)
      expect(mail.html).toContain(s)
    }
  })

  it('sends nothing when the sign-off closed no case', async () => {
    await sendFuelAuditReport(TEST_ORG_ID, 'ri1', [])
    expect(enqueueMail).not.toHaveBeenCalled()
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
