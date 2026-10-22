/**
 * Mailtrap transactional send, over SMTP.
 *
 * ## Why SMTP rather than the HTTP send API
 *
 * The HTTP API needs the sending domain verified before it will accept a
 * message; SMTP takes the same account's credentials and works against the
 * demo domain today. Since the domain is not verified yet, SMTP is the route
 * that actually delivers, and switching later is a host and a port.
 *
 * ## Why nodemailer, when nothing else here has a dependency for outbound
 *
 * Every other outbound call in this codebase is `fetch`, deliberately. SMTP is
 * where that stops being reasonable: it is a stateful, multi-step protocol
 * with STARTTLS negotiation and auth, and hand-rolling it on a socket to avoid
 * one dependency would be a far worse trade than the dependency.
 *
 * ## Connection handling
 *
 * One transport, created lazily and reused, with a pool. Building a transport
 * per message would open a TCP connection and do a TLS handshake and an AUTH
 * exchange for every invitation — several round trips to Europe before the
 * first byte of mail moves.
 *
 * `isConfigured` still gates everything: an unset token means the mailer is a
 * dormant no-op rather than a boot failure, exactly as before.
 */

import fs from 'node:fs'
import path from 'node:path'
import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { LOGO_CID } from '../../lib/mailer/templates.js'

/** Bounds a hung connection; SMTP has no equivalent of an AbortController. */
const SMTP_TIMEOUT_MS = 15_000

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
  private transport: Transporter | null = null

  constructor(
    private readonly token:    string = env.MAILTRAP_API_TOKEN,
    private readonly fromMail: string = env.MAIL_FROM_EMAIL,
    private readonly fromName: string = env.MAIL_FROM_NAME,
    private readonly host:     string = env.MAILTRAP_SMTP_HOST,
    private readonly port:     number = env.MAILTRAP_SMTP_PORT,
    private readonly user:     string = env.MAILTRAP_SMTP_USER,
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
    return Boolean(this.token && this.fromMail && this.host && this.user && this.baseUrl)
  }

  private getTransport(): Transporter {
    if (this.transport) return this.transport
    this.transport = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      // STARTTLS on 587/2525/25, implicit TLS on 465. `secure` means "TLS from
      // the first byte", which is true only of 465 — on 587 it would hang
      // waiting for a handshake the server does not start.
      secure: this.port === 465,
      requireTLS: this.port !== 465,
      auth: { user: this.user, pass: this.token },
      pool: true,
      maxConnections: 2,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout:  SMTP_TIMEOUT_MS,
      socketTimeout:    SMTP_TIMEOUT_MS,
    })
    return this.transport
  }

  async send(msg: MailtrapMessage): Promise<void> {
    const info = await this.getTransport().sendMail({
      from: { address: this.fromMail, name: this.fromName },
      to: msg.toName ? { address: msg.to, name: msg.toName } : msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      // Mailtrap reads this header for the category shown in its UI; the HTTP
      // API took it as a body field.
      ...(msg.category ? { headers: { 'X-MT-Category': msg.category } } : {}),
      // The letterhead logo travels inside the message (cid:) rather than as a
      // link: clients that hold back remote images until asked show it anyway.
      ...(msg.html.includes(`cid:${LOGO_CID}`) && logo() ? {
        attachments: [{ filename: 'rai-group.jpeg', content: logo()!, cid: LOGO_CID, contentType: 'image/jpeg' }],
      } : {}),
    })

    // A 2xx from the server is not proof of acceptance for every recipient:
    // SMTP can accept a message and reject one address in the same exchange.
    if (info.rejected?.length) {
      throw new Error(`SMTP rejected ${info.rejected.join(', ')} — ${info.response ?? 'no response'}`)
    }
  }

  /** Release pooled sockets — used by tests and by a clean shutdown. */
  close(): void {
    this.transport?.close()
    this.transport = null
  }
}

/**
 * The Rai Group logo, read once from <repo>/assets/report (where the PDF
 * reports already find it). Null when absent: the mail still goes, and the
 * letterhead shows the image's alt text.
 */
let logoBytes: Buffer | null | undefined
function logo(): Buffer | null {
  if (logoBytes === undefined) {
    try { logoBytes = fs.readFileSync(path.resolve(process.cwd(), 'assets', 'report', 'rai-group-logo.jpeg')) }
    catch { logoBytes = null; logger.warn('mail: assets/report/rai-group-logo.jpeg missing — letterhead goes without the logo') }
  }
  return logoBytes
}

export const mailtrapClient = new MailtrapClient()

/** Logged once at boot so a dormant mailer is visible rather than mysterious. */
export function logMailerStatus(): void {
  if (mailtrapClient.isConfigured) return
  logger.warn(
    'mail: not configured (MAILTRAP_API_TOKEN / MAIL_FROM_EMAIL / MAILTRAP_SMTP_HOST / MAILTRAP_SMTP_USER / APP_BASE_URL) — invites and password resets will not be delivered',
  )
}
