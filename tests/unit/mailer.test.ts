/**
 * The mailer's two invariants.
 *
 * Both are about what happens when mail does NOT work, because that is the
 * state this deployment runs in until a Mailtrap token is on the box, and
 * because the failure mode being guarded against is severe: sendMail is called
 * from inside API requests that have already committed their work, so a throw
 * here would turn a successful password change into a 500 and invite the user
 * to do it again.
 *
 *   1. Unconfigured is a silent, successful no-op — and does not touch fetch.
 *   2. A failing send is caught, whatever shape the failure takes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MailtrapClient } from '../../src/providers/mailtrap/mailtrap.client.js'
import { sendMail } from '../../src/lib/mailer/mailer.js'
import { inviteEmail, resetEmail, passwordChangedEmail } from '../../src/lib/mailer/templates.js'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const MAIL = inviteEmail({
  fullName: 'Maya Okonkwo',
  orgName: 'Sukari Industries',
  roleName: 'Dispatcher',
  link: 'https://fleet.example/#setup=abc',
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
})

/** A fully-configured client whose transport is ours to control. */
const configured = () => new MailtrapClient('tok', 'no-reply@demomailtrap.co', 'Rai', 'https://api.test/send', 'https://fleet.example')

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('sendMail — dormant when unconfigured', () => {
  it('reports unconfigured and never calls fetch when the token is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new MailtrapClient('', 'no-reply@demomailtrap.co', 'Rai', 'https://api.test/send', 'https://fleet.example')

    await expect(sendMail('a@b.test', 'A', MAIL, client)).resolves.toEqual({ sent: false, reason: 'unconfigured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('treats a missing APP_BASE_URL as unconfigured — a mail with a broken link is worse than none', async () => {
    const client = new MailtrapClient('tok', 'no-reply@demomailtrap.co', 'Rai', 'https://api.test/send', '')
    expect(client.isConfigured).toBe(false)
    await expect(sendMail('a@b.test', 'A', MAIL, client)).resolves.toEqual({ sent: false, reason: 'unconfigured' })
  })
})

describe('sendMail — a send failure never escapes', () => {
  it('resolves rather than rejecting when the transport throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    await expect(sendMail('a@b.test', 'A', MAIL, configured())).resolves.toEqual({ sent: false, reason: 'send-failed' })
  })

  it('resolves when Mailtrap rejects the sender (the unverified-domain 4xx)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => '{"errors":["sender domain not verified"]}',
    }))
    await expect(sendMail('a@b.test', 'A', MAIL, configured())).resolves.toEqual({ sent: false, reason: 'send-failed' })
  })

  it('carries the response body into the error, so 422 is diagnosable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => 'sender domain not verified',
    }))
    await expect(configured().send({ to: 'a@b.test', subject: 's', text: 't', html: '<p>t</p>' }))
      .rejects.toThrow(/422.*sender domain not verified/)
  })
})

describe('sendMail — happy path', () => {
  it('posts the shape Mailtrap expects', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(sendMail('driver@example.test', 'Maya Okonkwo', MAIL, configured())).resolves.toEqual({ sent: true })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/send')
    expect((init.headers as Record<string, string>)['Api-Token']).toBe('tok')

    const body = JSON.parse(String(init.body))
    expect(body.from).toEqual({ email: 'no-reply@demomailtrap.co', name: 'Rai' })
    expect(body.to).toEqual([{ email: 'driver@example.test', name: 'Maya Okonkwo' }])
    expect(body.subject).toBeTruthy()
    // Both parts, always — some clients render only text.
    expect(body.text).toContain('https://fleet.example/#setup=abc')
    expect(body.html).toContain('https://fleet.example/#setup=abc')
    expect(body.category).toBe('invite')
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
