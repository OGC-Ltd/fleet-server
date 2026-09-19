/**
 * What the handlers are told when a technician files a report — and, more
 * often in this deployment, what they are NOT told.
 *
 * The production box carries no MAILTRAP keys, so `unconfigured` is the
 * current live answer rather than an edge case. The thing that must never
 * happen is a technician being shown a tick for a mail that did not leave the
 * building: they would walk away believing the spare part had been ordered.
 * Every assertion below is a variation on that one worry.
 *
 * sendMail is mocked rather than exercised. Its own contract — that it cannot
 * reject, and resolves `{ sent: false }` instead — is already pinned in
 * mailer.test.ts; what is under test here is the fold from N per-recipient
 * results into the single status the dashboard prints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMailMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/mailer/mailer.js', () => ({ sendMail: sendMailMock }))

const envMock = vi.hoisted(() => ({ REPAIR_NOTIFY_EMAILS: '', APP_BASE_URL: '' }))
vi.mock('../../src/config/env.js', () => ({ env: envMock }))

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  repairReportItem: { findUnique: vi.fn() },
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotificationDurable: vi.fn(),
}))

import { notifyRepairAssignment, repairRecipients, notifyRepairReport } from '../../src/modules/repairs/repairs.service.js'
import { repairAssignmentEmail, repairReportEmail } from '../../src/lib/mailer/templates.js'

const REPORTED_AT = new Date('2026-09-16T14:02:00Z')

/** A mixed batch — the case the whole feature exists for. */
const report = (): Parameters<typeof notifyRepairReport>[0] => ({
  id: 'rep_1',
  reportedAt: REPORTED_AT,
  note: 'Yard was half flooded; three units unreachable.',
  reportedBy: { id: 'u1', fullName: 'Amina Wanjiru', email: 'a@x.com' },
  items: [
    { outcome: 'needs_spare', faultKind: 'fuel_probe_dead', sparePart: 'Gill LS-5 float sender, 600 mm',
      problemNote: 'Reads zero with the tank half full; harness continuity OK.',
      vehicle: { registrationPlate: 'KBZ 431A' } },
    { outcome: 'cannot_fix', faultKind: 'ignition_not_reporting', sparePart: null,
      problemNote: 'Loom damaged behind the dash; unit must come off the road.',
      vehicle: { registrationPlate: 'KBX 902Q' } },
    { outcome: 'fixing', faultKind: 'gps_not_reporting', sparePart: null, problemNote: null,
      vehicle: { registrationPlate: 'KBN 550L' } },
    { outcome: 'fixing', faultKind: null, sparePart: null, problemNote: null,
      vehicle: { registrationPlate: 'KCB 771D' } },
  ],
} as unknown as Parameters<typeof notifyRepairReport>[0])

beforeEach(() => {
  vi.clearAllMocks()
  envMock.REPAIR_NOTIFY_EMAILS = ''
  envMock.APP_BASE_URL = ''
  sendMailMock.mockResolvedValue({ sent: true })
  prismaMock.user.findUnique.mockReset()
  prismaMock.repairReportItem.findUnique.mockReset()
})

describe('repairRecipients — one list, cleaned', () => {
  it('trims, lowercases, dedupes and drops the empties a hand-edited env line leaves behind', () => {
    envMock.REPAIR_NOTIFY_EMAILS = ' A@x.com , a@X.com ,, b@x.com '
    expect(repairRecipients()).toEqual(['a@x.com', 'b@x.com'])
  })

  it('reads an unset list as nobody, not as a crash', () => {
    expect(repairRecipients()).toEqual([])
  })
})

describe('the send outcome is reported, never assumed', () => {
  it('says no-recipients, and does not open a socket, when nobody is configured', async () => {
    const out = await notifyRepairReport(report(), 'Rai Sugar', 'Amina Wanjiru')
    expect(out.status).toBe('no-recipients')
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('says sent only when every recipient took it', async () => {
    envMock.REPAIR_NOTIFY_EMAILS = 'a@x.com,b@x.com,c@x.com'
    const out = await notifyRepairReport(report(), 'Rai Sugar', 'Amina Wanjiru')
    expect(out.status).toBe('sent')
    expect(out.sent).toHaveLength(3)
    expect(out.failed).toEqual([])
  })

  it('says partial, and names who was missed, when one address fails', async () => {
    envMock.REPAIR_NOTIFY_EMAILS = 'a@x.com,b@x.com,c@x.com'
    sendMailMock
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce({ sent: false, reason: 'send-failed' })
      .mockResolvedValueOnce({ sent: true })
    const out = await notifyRepairReport(report(), 'Rai Sugar', 'Amina Wanjiru')
    expect(out.status).toBe('partial')
    expect(out.failed).toEqual(['b@x.com'])
    expect(out.sent).toEqual(['a@x.com', 'c@x.com'])
  })

  it('distinguishes a dormant mailer from a failing one', async () => {
    envMock.REPAIR_NOTIFY_EMAILS = 'a@x.com,b@x.com'
    sendMailMock.mockResolvedValue({ sent: false, reason: 'unconfigured' })
    expect((await notifyRepairReport(report(), 'Rai Sugar', 'A. W.')).status).toBe('unconfigured')

    sendMailMock.mockResolvedValue({ sent: false, reason: 'send-failed' })
    expect((await notifyRepairReport(report(), 'Rai Sugar', 'A. W.')).status).toBe('failed')
  })
})

describe('triage assignment notifications', () => {
  it('sends an email when the task is assigned to someone else', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ fullName: 'Amina Wanjiru', email: 'a@x.com' })
      .mockResolvedValueOnce({ fullName: 'Benson Otieno', email: 'b@x.com' })
    prismaMock.repairReportItem.findUnique.mockResolvedValue({
      vehicle: { registrationPlate: 'KBZ 431A' },
      faultKind: 'fuel_probe_dead',
      organisationId: 'org-1',
    })

    await notifyRepairAssignment({
      itemId: 'r1',
      orgId: 'org-1',
      assignedById: 'u1',
      assignedToId: 'u2',
      reason: 'Please inspect today',
    })

    expect(sendMailMock).toHaveBeenCalledTimes(1)
    expect(sendMailMock.mock.calls[0]?.[0]).toBe('b@x.com')
  })

  it('does not email the assigner when they triage the task to themselves', async () => {
    await notifyRepairAssignment({
      itemId: 'r1',
      orgId: 'org-1',
      assignedById: 'u1',
      assignedToId: 'u1',
      reason: 'Self-triage',
    })

    expect(sendMailMock).not.toHaveBeenCalled()
  })
})

describe('the mail itself', () => {
  const mail = () => repairReportEmail({
    orgName: 'Rai Sugar',
    technicianName: 'Amina Wanjiru',
    reportedAt: REPORTED_AT,
    items: [
      { plate: 'KBZ 431A', label: 'Fuel probe dead', outcome: 'needs_spare',
        sparePart: 'Gill LS-5 float sender', problemNote: 'Reads zero.',
        expectedResolutionAt: new Date('2026-09-25T00:00:00.000Z') },
      { plate: 'KBX 902Q', label: 'Ignition not reporting', outcome: 'cannot_fix',
        problemNote: 'Loom damaged.' },
      { plate: 'KBN 550L', label: 'GPS not reporting', outcome: 'fixing' },
    ],
  })

  it('carries the triage in the subject, where a handler reads it', () => {
    expect(mail().subject)
      .toBe('[Rai Sugar] Repair report — 3 units · 1 needs spares · 1 cannot be fixed')
  })

  it('collapses to "all in hand" when there is nothing to action', () => {
    const m = repairReportEmail({
      orgName: 'Rai Sugar', technicianName: 'A. W.', reportedAt: REPORTED_AT,
      items: [{ plate: 'KBN 550L', label: 'GPS not reporting', outcome: 'fixing' }],
    })
    expect(m.subject).toBe('[Rai Sugar] Repair report — 1 unit · all in hand')
  })

  it('puts the actionable groups above the finished one', () => {
    const t = mail().text
    expect(t.indexOf('Spare parts needed')).toBeLessThan(t.indexOf('Cannot be fixed'))
    expect(t.indexOf('Cannot be fixed')).toBeLessThan(t.indexOf('Being fixed ('))
  })

  it('names the part in the plain-text part, which some clients are all they render', () => {
    expect(mail().text).toContain('Part: Gill LS-5 float sender')
  })

  /*
   * The date is the half of "order this part" that makes the order chaseable,
   * so it has to survive into the body of the mail — not just into the table
   * on a dashboard the handlers may never open.
   */
  it('states the fix date, beside the part it is waiting on', () => {
    const t = mail().text
    expect(t).toContain('Fix date: 2026-09-25')
    // Beside the part, not stranded at the bottom under the units that need
    // nothing: a handler reading the plain-text part gets one instruction.
    expect(t.indexOf('Part: Gill LS-5 float sender')).toBeLessThan(t.indexOf('Fix date:'))
    expect(t.indexOf('Fix date:')).toBeLessThan(t.indexOf('Cannot be fixed'))
  })

  it('renders the date in the HTML part too', () => {
    expect(mail().html).toContain('Fix date: 2026-09-25')
  })

  /*
   * The stored column is a DATE at midnight UTC and this fleet is at UTC+3.
   * Anything that localises on the way out turns "the 25th" into the 24th for
   * some readers — see the template's `due()`. Pinned because it is silent.
   */
  it('does not let a timezone move the date by a day', () => {
    const m = repairReportEmail({
      orgName: 'Rai Sugar', technicianName: 'A. W.', reportedAt: REPORTED_AT,
      items: [{
        plate: 'KBZ 431A', label: 'Fuel probe dead', outcome: 'needs_spare',
        sparePart: 'Sender', expectedResolutionAt: new Date('2026-01-01T00:00:00.000Z'),
      }],
    })
    expect(m.text).toContain('Fix date: 2026-01-01')
    expect(m.text).not.toContain('2025-12-31')
  })

  it('says nothing about a date on an item that has none', () => {
    const m = repairReportEmail({
      orgName: 'Rai Sugar', technicianName: 'A. W.', reportedAt: REPORTED_AT,
      items: [{ plate: 'KBN 550L', label: 'GPS not reporting', outcome: 'fixing' }],
    })
    expect(m.text).not.toContain('Fix date')
    expect(m.html).not.toContain('Fix date')
  })

  it('escapes a part name that is trying to be markup', () => {
    const m = repairReportEmail({
      orgName: 'Rai Sugar', technicianName: 'A. W.', reportedAt: REPORTED_AT,
      items: [{ plate: 'KBZ 431A', label: 'Fuel probe dead', outcome: 'needs_spare',
        sparePart: '<script>alert(1)</script>' }],
    })
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
  })

  it('offers no button when there is no origin to point it at', () => {
    expect(mail().html).not.toContain('Open the Maintenance screen')
  })

  it('offers one when there is', () => {
    const m = repairReportEmail({
      orgName: 'Rai Sugar', technicianName: 'A. W.', reportedAt: REPORTED_AT,
      link: 'https://fleet.example',
      items: [{ plate: 'KBN 550L', label: 'GPS not reporting', outcome: 'fixing' }],
    })
    expect(m.html).toContain('https://fleet.example')
    expect(m.text).toContain('Open the Maintenance screen: https://fleet.example')
  })
})
