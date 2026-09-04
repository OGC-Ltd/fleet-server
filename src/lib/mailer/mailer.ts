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
 * The cost is that a request can wait on a slow Mailtrap; the client's
 * AbortController bounds that at 10s. Moving this onto a queue is the right
 * eventual answer, but Redis is optional in this deployment and a queued mail
 * that never sends because Redis is absent is worse than a slow request.
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
  | { sent: false; reason: 'unconfigured' | 'send-failed' }

export async function sendMail(
  to: string,
  toName: string | null | undefined,
  mail: RenderedMail,
  client: MailtrapClient = mailtrapClient,
): Promise<MailResult> {
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
    logger.error({ err, template: mail.category, to }, 'mail: send failed')
    return { sent: false, reason: 'send-failed' }
  }
}
