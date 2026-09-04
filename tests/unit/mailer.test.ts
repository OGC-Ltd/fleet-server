/**
 * The mailer's two invariants.
 *
 * Both are about what happens when mail does NOT work, because that is the
 * state this deployment runs in whenever a credential is missing, and because
 * the failure being guarded against is severe: sendMail is called from inside
 * API requests that have already committed their work, so a throw here would
 * turn a successful password change into a 500 and invite the user to do it
 * again.
 *
 *   1. Unconfigured is a silent, successful no-op — and never opens a socket.
 *   2. A failing send is caught, whatever shape the failure takes.
 *
 * nodemailer is mocked rather than pointed at a real server: these tests are
 * about the wrapper's contract, and a unit test that needs the network is a
 * unit test that fails on a train.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Typed params, so asserting on mock.calls[0][0] type-checks instead of
// indexing an empty tuple.
type SentMail = Record<string, unknown>
type TransportOpts = Record<string, unknown>
const sendMailSpy = vi.hoisted(() =>
  vi.fn(async (_m: SentMail) => ({ rejected: [] as string[], response: '250 OK' })))
const createTransport = vi.hoisted(() =>
  vi.fn((_o: TransportOpts) => ({ sendMail: sendMailSpy, close: () => {} })))
vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { MailtrapClient } from '../../src/providers/mailtrap/mailtrap.client.js'
import { sendMail } from '../../src/lib/mailer/mailer.js'
import { inviteEmail, resetEmail, passwordChangedEmail } from '../../src/lib/mailer/templates.js'

const MAIL = inviteEmail({
  fullName: 'Maya Okonkwo',
  orgName: 'Sukari Industries',
  roleName: 'Dispatcher',
  link: 'https://fleet.example/#setup=abc',
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
})

/** A fully-configured client whose transport is ours to control. */
const configured = (port = 587) =>
  new MailtrapClient('tok', 'no-reply@raioperations.com', 'Rai', 'live.smtp.mailtrap.io', port, 'api', 'https://fleet.example')

beforeEach(() => {
  vi.clearAllMocks()
  sendMailSpy.mockResolvedValue({ rejected: [], response: '250 OK' })
})

describe('sendMail — dormant when unconfigured', () => {
  it('reports unconfigured and never builds a transport when the token is missing', async () => {
    const client = new MailtrapClient('', 'no-reply@raioperations.com', 'Rai', 'live.smtp.mailtrap.io', 587, 'api', 'https://fleet.example')

    await expect(sendMail('a@b.test', 'A', MAIL, client)).resolves.toEqual({ sent: false, reason: 'unconfigured' })
    expect(createTransport).not.toHaveBeenCalled()
    expect(sendMailSpy).not.toHaveBeenCalled()
  })

  it('treats a missing APP_BASE_URL as unconfigured — a mail with a broken link is worse than none', async () => {
    const client = new MailtrapClient('tok', 'no-reply@raioperations.com', 'Rai', 'live.smtp.mailtrap.io', 587, 'api', '')
    expect(client.isConfigured).toBe(false)
    await expect(sendMail('a@b.test', 'A', MAIL, client)).resolves.toEqual({ sent: false, reason: 'unconfigured' })
  })

  it('treats a missing SMTP user as unconfigured', async () => {
    const client = new MailtrapClient('tok', 'no-reply@raioperations.com', 'Rai', 'live.smtp.mailtrap.io', 587, '', 'https://fleet.example')
    expect(client.isConfigured).toBe(false)
  })
})

describe('sendMail — a send failure never escapes', () => {
  it('resolves rather than rejecting when the transport throws', async () => {
    sendMailSpy.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(sendMail('a@b.test', 'A', MAIL, configured())).resolves.toEqual({ sent: false, reason: 'send-failed' })
  })

  it('resolves when the server refuses the sender (the unverified-domain case)', async () => {
    sendMailSpy.mockRejectedValueOnce(Object.assign(new Error('550 sender not allowed'), { responseCode: 550 }))
    await expect(sendMail('a@b.test', 'A', MAIL, configured())).resolves.toEqual({ sent: false, reason: 'send-failed' })
  })

  it('treats a per-recipient rejection as a failure, not a success', async () => {
    // SMTP can accept the message and refuse one address in the same exchange.
    // Reporting that as sent would tell an admin an invitation is on its way
    // when nothing was delivered.
    sendMailSpy.mockResolvedValueOnce({ rejected: ['a@b.test'], response: '550 no such user' })
    await expect(sendMail('a@b.test', 'A', MAIL, configured())).resolves.toEqual({ sent: false, reason: 'send-failed' })
  })
})

describe('sendMail — happy path', () => {
  it('sends with the credentials and shape Mailtrap expects', async () => {
    await expect(sendMail('driver@example.test', 'Maya Okonkwo', MAIL, configured())).resolves.toEqual({ sent: true })

    const transport = createTransport.mock.calls[0]![0]
    expect(transport).toMatchObject({
      host: 'live.smtp.mailtrap.io',
      port: 587,
      // STARTTLS on 587, not implicit TLS — `secure: true` here would hang
      // waiting for a handshake the server never starts.
      secure: false,
      requireTLS: true,
      auth: { user: 'api', pass: 'tok' },
    })

    const sent = sendMailSpy.mock.calls[0]![0]
    expect(sent['from']).toEqual({ address: 'no-reply@raioperations.com', name: 'Rai' })
    expect(sent['to']).toEqual({ address: 'driver@example.test', name: 'Maya Okonkwo' })
    // Both parts, always — some clients render only text.
    expect(String(sent['text'])).toContain('https://fleet.example/#setup=abc')
    expect(String(sent['html'])).toContain('https://fleet.example/#setup=abc')
  })

  it('uses implicit TLS on 465', async () => {
    await sendMail('a@b.test', 'A', MAIL, configured(465))
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ port: 465, secure: true, requireTLS: false })
  })

  it('reuses one transport across sends rather than reconnecting per message', async () => {
    const client = configured()
    await sendMail('a@b.test', 'A', MAIL, client)
    await sendMail('c@d.test', 'C', MAIL, client)
    expect(createTransport).toHaveBeenCalledTimes(1)
    expect(sendMailSpy).toHaveBeenCalledTimes(2)
  })
})

describe('templates', () => {
  it('every template ships both a text and an html part', () => {
    const mails = [
      MAIL,
      resetEmail({ fullName: 'Sam Tan', link: 'https://fleet.example/#setup=x', expiresAt: new Date(Date.now() + 3_600_000) }),
      passwordChangedEmail({ fullName: 'Sam Tan', when: new Date('2026-09-04T10:00:00Z'), ip: '10.0.0.1' }),
    ]
    for (const m of mails) {
      expect(m.text.trim().length).toBeGreaterThan(40)
      expect(m.html).toContain('<')
      expect(m.subject.length).toBeGreaterThan(5)
    }
  })

  it('escapes a name that contains markup', () => {
    const m = resetEmail({ fullName: '<script>x</script>', link: 'https://f.test/#setup=1', expiresAt: new Date(Date.now() + 3_600_000) })
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
  })

  it('the password-changed notice carries no link — it is a signal, not an action', () => {
    const m = passwordChangedEmail({ fullName: 'Sam Tan', when: new Date() })
    expect(m.html).not.toContain('<a ')
    expect(m.text).not.toContain('http')
  })
})
