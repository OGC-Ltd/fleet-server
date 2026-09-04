/**
 * Mailtrap transactional-send client.
 *
 * Mailtrap's send API is plain HTTP, so this needs no dependency — the project
 * has no mail library and does not gain one here. Everything outbound in this
 * codebase already goes through global `fetch` with an AbortController
 * (see providers/raifactorysuite/raifactorysuite.client.ts), and this follows
 * that shape exactly: constructor-injected credentials defaulted from env, an
 * `isConfigured` getter so an unset key means DORMANT rather than a boot
 * failure, and a bounded request.
 *
 * Until the sending domain is verified, the from-address has to be the
 * demomailtrap.co one Mailtrap issues; anything else comes back 4xx. That is
 * why the response body is included in the thrown error — "422" alone does not
 * tell you your sender is unverified, and that is the failure you will actually
 * hit first.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

const REQUEST_TIMEOUT_MS = 10_000

export interface MailtrapMessage {
  to:        string
  toName?:   string | undefined
  subject:   string
  text:      string
  html:      string
  /** Groups sends in Mailtrap's UI. One per template. */
  category?: string | undefined
}

export class MailtrapClient {
  constructor(
    private readonly token:    string = env.MAILTRAP_API_TOKEN,
    private readonly fromMail: string = env.MAIL_FROM_EMAIL,
    private readonly fromName: string = env.MAIL_FROM_NAME,
    private readonly url:      string = env.MAILTRAP_API_URL,
    private readonly baseUrl:  string = env.APP_BASE_URL,
  ) {}

  /**
   * False when anything needed to send a USEFUL mail is missing.
   *
   * `baseUrl` is in here deliberately: every message this system sends carries
   * a link back to the dashboard, so without an origin the mail would arrive
   * and be useless. Silence is the better failure.
   */
  get isConfigured(): boolean {
    return Boolean(this.token && this.fromMail && this.baseUrl)
  }

  async send(msg: MailtrapMessage): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Api-Token':    this.token,
          'Content-Type': 'application/json',
          accept:         'application/json',
        },
        body: JSON.stringify({
          from: { email: this.fromMail, name: this.fromName },
          to:   [{ email: msg.to, ...(msg.toName ? { name: msg.toName } : {}) }],
          subject: msg.subject,
          text:    msg.text,
          html:    msg.html,
          ...(msg.category ? { category: msg.category } : {}),
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        // The body carries the reason — an unverified sending domain reads as a
        // generic 4xx without it.
        const detail = await res.text().catch(() => '')
        throw new Error(`Mailtrap responded ${res.status}: ${detail.slice(0, 400)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const mailtrapClient = new MailtrapClient()

/** Logged once at boot so a dormant mailer is visible rather than mysterious. */
export function logMailerStatus(): void {
  if (mailtrapClient.isConfigured) return
  logger.warn(
    'mail: not configured (MAILTRAP_API_TOKEN / MAIL_FROM_EMAIL / APP_BASE_URL) — invites and password resets will not be delivered',
  )
}
