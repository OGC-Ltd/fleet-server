/**
 * sendMail — the one entry point, and it CANNOT reject.
 *
 * ## Why the signature is what it is
 *
 * Every caller here is an API request that has already succeeded: the password
 * is changed, the user is provisioned, the row is written. The mail is a
 * notification about that fact, not part of it. So a mail failure must never
 * turn a 200 into a 500 — the work is done either way, and telling the caller
 * it failed would be a lie that invites them to retry a thing that already
 * happened.
 *
 * It returns a result instead of throwing, and callers `await` it. That is
 * deliberately NOT fire-and-forget: a floating promise that rejects takes the
 * process down under Node's default unhandled-rejection behaviour. Awaiting a
 * function that structurally cannot reject is the shape that is safe in both
 * directions.
 *
 * ## MOST CALLERS SHOULD NOT CALL THIS DIRECTLY ANY MORE
 *
 * The cost of the above is that a request waits on a slow Mailtrap; the
 * client's AbortController bounds that at 10s, per recipient. `enqueueMail` in
 * lib/queues/outbound is the entry point now: it hands the rendered mail to
 * BullMQ and returns, and the worker calls THIS function.
 *
 * This docblock used to argue against that, on the grounds that "Redis is
 * optional in this deployment and a queued mail that never sends because Redis
 * is absent is worse than a slow request". The objection was right and it is
 * answered rather than overruled: `enqueueMail` FALLS BACK to calling this
 * inline when there is no queue, and again when the queue is configured but
 * refuses the job. With REDIS_URL unset — the production state today —
 * behaviour is byte-for-byte what it was before the queue existed.
 *
 * Call this directly only from inside that worker, or from a one-shot script
 * that will exit before a queued job could ever run.
 *
 * ## Dormant is a first-class outcome
 *
 * With no token configured this returns { sent: false, reason: 'unconfigured' }
 * and logs. Callers are expected to SURFACE that rather than smooth it over —
 * an invited user whose mail was never sent has no way into the system at all,
 * so the admin needs to be told, not shown a tick.
 */

import { mailtrapClient, type MailtrapClient } from '../../providers/mailtrap/mailtrap.client.js'
import { logger } from '../logger.js'
import type { RenderedMail } from './templates.js'

export type MailResult =
  | { sent: true }
  /** `retryAfterMs` is set only when the provider said "not now" rather than "no". */
  | { sent: false; reason: 'unconfigured' | 'send-failed' | 'not-allowed'; retryAfterMs?: number }

/**
 * The only mail that may leave: account access (operator, 2026-10-28).
 * Repair notices, escalations included, and faulty-sensor notices go by Web
 * Push instead. A
 * template outside this set is refused here, the one choke point, so a new
 * caller cannot quietly start spending the provider's daily quota again.
 */
export const ALLOWED_MAIL_CATEGORIES: ReadonlySet<string> = new Set([
  'invite', 'password-reset', 'password-changed',
])

export function isMailAllowed(category: string): boolean {
  return ALLOWED_MAIL_CATEGORIES.has(category)
}

/** When the provider names no time, ask again after this long. */
const THROTTLE_DEFAULT_MS = 15 * 60_000

/**
 * How long until the provider will take mail again, or null for a failure a
 * wait will not fix.
 *
 * Mailtrap refuses the SMTP login once the account's daily quota is spent,
 * with "535 5.7.8 Your account has reached its daily sending limit ... retry
 * in 1h11m12s". A 535 is normally a wrong password, so the wording is what
 * tells the two apart. 421 and 450-452 are SMTP's own "try later" codes.
 */
export function throttleDelayMs(err: unknown): number | null {
  const e = err as { responseCode?: number; response?: string; message?: string } | null
  const text = `${e?.response ?? ''} ${e?.message ?? ''}`
  const code = e?.responseCode
  const limited = /sending limit|rate limit|too many/i.test(text)
  if (!limited && code !== 421 && code !== 450 && code !== 451 && code !== 452) return null
  const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text)
  if (m && (m[1] || m[2] || m[3])) {
    return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
  }
  return THROTTLE_DEFAULT_MS
}

export async function sendMail(
  to: string,
  toName: string | null | undefined,
  mail: RenderedMail,
  client: MailtrapClient = mailtrapClient,
): Promise<MailResult> {
  if (!isMailAllowed(mail.category)) {
    logger.warn({ template: mail.category, to }, 'mail: template is not allowed to send — nothing sent')
    return { sent: false, reason: 'not-allowed' }
  }
  if (!client.isConfigured) {
    logger.warn({ template: mail.category, to }, 'mail: not configured — nothing sent')
    return { sent: false, reason: 'unconfigured' }
  }

  try {
    await client.send({
      to,
      toName: toName ?? undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      category: mail.category,
    })
    logger.info({ template: mail.category, to }, 'mail: sent')
    return { sent: true }
  } catch (err) {
    // Swallowed on purpose — see the header. The log is the record.
    const retryAfterMs = throttleDelayMs(err)
    if (retryAfterMs != null) {
      logger.warn({ err, template: mail.category, to, retryAfterMs }, 'mail: provider is throttling — will wait')
      return { sent: false, reason: 'send-failed', retryAfterMs }
    }
    logger.error({ err, template: mail.category, to }, 'mail: send failed')
    return { sent: false, reason: 'send-failed' }
  }
}
