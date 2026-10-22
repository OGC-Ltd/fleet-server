/**
 * The mails this system sends.
 *
 * Inline template literals rather than .html files on purpose: the build is
 * `prisma generate && tsc`, tsc emits only .js, and there is no asset-copy
 * step — so an .html file under src/ simply would not exist in dist/ and every
 * send would fail on the box while passing locally. Strings survive the build
 * that exists.
 *
 * Every template ships a PLAIN-TEXT part as well as HTML. Some clients render
 * only text, and a security mail that arrives blank is worse than no mail.
 */

/** Minimal escaping for the few user-controlled values that reach the HTML. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface RenderedMail {
  subject: string
  text:    string
  html:    string
  category: string
}

/*
 * Hallmark · macrostructure: Letter (memo slip) · tone: utilitarian · anchor hue: blue 221°
 * theme: new-ui's own palette (src/index.css) · enrichment: none (typography only)
 *
 * ## The layout every mail shares
 *
 *   letterhead     [logo]  FLEET OPERATIONS  ·  <organisation>   (on the grey paper)
 *   ┌ sheet ─────────────────────────────────────────────┐
 *   │ status         only when the mail carries a verdict │
 *   │ heading                                             │
 *   │ body, then a docket of label / value rows           │
 *   │ [ one button ]   and the same link written out      │
 *   │ small print: how long the link lasts, and so on     │
 *   └─────────────────────────────────────────────────────┘
 *   footer         who sent it, the domain, why you got it
 *
 * Mail is not a browser. Gmail and Outlook drop custom properties, OKLCH and
 * most of <style>, and many clients block images until asked, so the tokens
 * below are hex, every style is inline, and the layout is tables. The Rai
 * Group logo is ATTACHED to the message and referenced by cid:, not linked,
 * because a linked image is exactly what those clients hold back; its alt
 * text reads "RAI GROUP" for the ones that still do.
 *
 * The footer names the domain as TEXT, never a link. A reader checking that a
 * mail is genuine should compare it with the address bar, and the password-
 * changed notice must carry no link at all.
 */

/** The address people know the dashboard by. APP_BASE_URL should be this. */
export const OFFICIAL_SITE = 'https://logistics.raioperations.com'
const SENDER = 'Rai Group Fleet'
/** Content-ID of the Rai Group logo the mail client attaches (mailtrap.client). */
export const LOGO_CID = 'rai-group-logo'

const T = {
  paper:  '#f1f5f9',
  sheet:  '#ffffff',
  rule:   '#e2e8f0',
  ink:    '#0f172a',
  ink2:   '#334155',
  muted:  '#5f6e83',
  accent: '#2563eb',
  onAccent: '#ffffff',
  ok:     '#15803d',
  warn:   '#b45309',
  crit:   '#b91c1c',
  font:   "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono:   "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace",
} as const

type Tone = 'ok' | 'warn' | 'crit'

/** Body copy. */
const para = (html: string): string =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${T.ink2}">${html}</p>`
/** Small print: link lifetimes, "if this was not you". */
const note = (html: string, colour: string = T.muted): string =>
  `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${colour}">${html}</p>`
/** A section title inside the sheet. */
const h2 = (s: string, colour: string = T.ink): string =>
  `<h2 style="margin:26px 0 8px;font-size:14px;line-height:1.4;font-weight:600;color:${colour}">${esc(s)}</h2>`
/** Plates and ticket numbers read as codes, so they are set as codes. */
const code = (s: string): string =>
  `<span style="font-family:${T.mono};font-size:13px;color:${T.ink}">${esc(s)}</span>`
const strong = (s: string): string => `<strong style="color:${T.ink};font-weight:600">${esc(s)}</strong>`

/**
 * Label / value rows with hairlines between them. Values are HTML (a plate set
 * in mono); `kv` escapes a plain string into one.
 */
function docket(rows: Array<[label: string, valueHtml: string] | null | false | undefined | ''>): string {
  const live = rows.filter((r): r is [string, string] => Boolean(r))
  if (live.length === 0) return ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:2px 0 8px">${
    live.map(([k, v], i) => {
      const line = i ? `border-top:1px solid ${T.rule};` : ''
      return `<tr>
      <td style="padding:8px 14px 8px 0;width:34%;vertical-align:top;font-size:13px;line-height:1.5;color:${T.muted};${line}">${esc(k)}</td>
      <td style="padding:8px 0;vertical-align:top;font-size:14px;line-height:1.5;color:${T.ink};${line}">${v}</td>
    </tr>`
    }).join('')
  }</table>`
}
const kv = (k: string, v: string): [string, string] => [k, esc(v)]

/** A list with room between the items; `items` are HTML. */
const list = (items: string[], ordered = false): string => {
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag} style="margin:0 0 6px;padding-left:20px;font-size:14px;line-height:1.55;color:${T.ink2}">${
    items.map((i) => `<li style="margin:0 0 8px">${i}</li>`).join('')
  }</${tag}>`
}
/** A muted second line inside a list item or table cell. */
const sub = (html: string, colour: string = T.muted): string =>
  `<br><span style="font-size:13px;color:${colour}">${html}</span>`

/** The domain without its scheme, for the footer. */
const siteName = (): string => OFFICIAL_SITE.replace(/^https?:\/\//, '')

function shell(opts: {
  /** Already escaped. */
  heading:   string
  body:      string
  action?:   { href: string; label: string } | undefined
  /** Small print under the button (or under the body when there is none). */
  after?:    string | undefined
  /** The line a mail client shows beside the subject. Plain text. */
  preheader: string
  /** A verdict worth seeing before the heading: "Needs attention". */
  status?:   { tone: Tone; label: string } | undefined
  /** The organisation the mail is about, beside the letterhead. */
  org?:      string | undefined
  /** Why this person got it, for the footer. Plain text. */
  reason:    string
}): string {
  const status = opts.status
    ? `<p style="margin:0 0 10px;font-size:13px;line-height:1.4;font-weight:600;color:${T[opts.status.tone]}">&#9679;&nbsp;${esc(opts.status.label)}</p>`
    : ''
  const action = opts.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 14px"><tr>
        <td style="border-radius:6px;background:${T.accent}">
          <a href="${esc(opts.action.href)}" style="display:inline-block;padding:12px 22px;font-family:${T.font};font-size:15px;font-weight:600;line-height:1.2;color:${T.onAccent};text-decoration:none;border-radius:6px;white-space:nowrap">${esc(opts.action.label)}</a>
        </td></tr></table>
      ${note(`Button not working? Paste this into your browser:<br><span style="word-break:break-all;color:${T.ink2}">${esc(opts.action.href)}</span>`)}`
    : ''
  const after = opts.after
    ? `<div style="margin-top:${opts.action ? 4 : 10}px">${opts.after}</div>`
    : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${opts.heading}</title>
<style>@media (max-width:480px){.sheet{padding:24px 20px !important}.wrap{padding:16px 8px !important}}</style>
</head>
<body style="margin:0;padding:0;background:${T.paper};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${T.paper}">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.paper}">
<tr><td class="wrap" align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${T.font}">
    <tr><td style="padding:0 0 16px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:14px">
          <img src="cid:${LOGO_CID}" width="56" height="63" alt="RAI GROUP" style="display:block;width:56px;height:63px;border:0;border-radius:6px;background:${T.ink};color:${T.sheet};font-size:9px;font-weight:700;text-align:center">
        </td>
        <td style="vertical-align:middle;font-size:12px;line-height:1.4;letter-spacing:.08em;text-transform:uppercase;color:${T.muted}">
          <strong style="color:${T.ink};font-weight:700">Fleet operations</strong>${opts.org ? `&nbsp;&nbsp;&middot;&nbsp;&nbsp;${esc(opts.org)}` : ''}
        </td>
      </tr></table>
    </td></tr>
    <tr><td class="sheet" style="background:${T.sheet};border:1px solid ${T.rule};border-radius:8px;padding:32px 36px">
      ${status}
      <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-.01em;color:${T.ink}">${opts.heading}</h1>
      ${opts.body}
      ${action}
      ${after}
    </td></tr>
    <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.6;color:${T.muted}">
      Sent by ${SENDER} from <strong style="color:${T.ink2};font-weight:600">${siteName()}</strong>.<br>
      ${esc(opts.reason)}
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`
}

/** The footer of every plain-text part. */
const textFooter = (reason: string): string => `\n--\n${SENDER} · ${siteName()}\n${reason}\n`

/** How long a link lasts, in words rather than a timestamp in another timezone. */
function validFor(expiresAt: Date, now: Date = new Date()): string {
  const hours = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000))
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${Math.round(hours / 24)} days`
}

const INVITE_REASON  = 'You are getting this because an administrator added you. If you were not expecting it, ignore it: the account cannot be used until a password is set.'
const RESET_REASON   = 'You are getting this because a password reset was asked for on this address.'
const CHANGED_REASON = 'You are getting this because the password on your account changed. This notice goes out on every change.'
const REPAIR_REASON  = 'You are getting this because you handle repairs for this organisation.'
const AUDIT_REASON   = 'You are getting this because you handle fuel audits for this organisation.'

export function inviteEmail(opts: {
  fullName: string
  orgName: string
  roleName?: string | undefined
  link: string
  expiresAt: Date
}): RenderedMail {
  const window = validFor(opts.expiresAt)
  const role = opts.roleName ? ` as ${opts.roleName}` : ''
  return {
    category: 'invite',
    subject: `Set up your ${opts.orgName} fleet account`,
    text:
      `Hello ${opts.fullName},\n\n` +
      `An account has been created for you at ${opts.orgName}${role}.\n\n` +
      `Choose a password to finish setting it up:\n${opts.link}\n\n` +
      `This link works once and expires in ${window}.\n\n` +
      `If you were not expecting this, you can ignore this message — the account cannot be used until a password is set.\n` +
      textFooter(INVITE_REASON),
    html: shell({
      heading: `Set up your ${esc(opts.orgName)} account`,
      preheader: `Choose a password to start using the ${opts.orgName} fleet dashboard.`,
      org: opts.orgName,
      body:
        para(`Hello ${esc(opts.fullName)},`) +
        para(`An account has been created for you at ${strong(opts.orgName)}${opts.roleName ? ` as ${strong(opts.roleName)}` : ''}. Choose a password to finish setting it up.`),
      action: { href: opts.link, label: 'Set your password' },
      after: note(`This link works once and expires in ${window}.`),
      reason: INVITE_REASON,
    }),
  }
}

export function resetEmail(opts: { fullName: string; link: string; expiresAt: Date }): RenderedMail {
  const window = validFor(opts.expiresAt)
  return {
    category: 'password-reset',
    subject: 'Reset your fleet dashboard password',
    text:
      `Hello ${opts.fullName},\n\n` +
      `Someone asked to reset the password on this account. To choose a new one:\n${opts.link}\n\n` +
      `This link works once and expires in ${window}.\n\n` +
      `If this was not you, ignore this message. Nothing has changed and your current password still works.\n` +
      textFooter(RESET_REASON),
    html: shell({
      heading: 'Reset your password',
      preheader: `Choose a new password. The link expires in ${window}.`,
      body:
        para(`Hello ${esc(opts.fullName)},`) +
        para('Someone asked to reset the password on this account. Choose a new one below.'),
      action: { href: opts.link, label: 'Choose a new password' },
      after:
        note(`This link works once and expires in ${window}.`) +
        note('If this was not you, ignore this message. Nothing has changed and your current password still works.'),
      reason: RESET_REASON,
    }),
  }
}

/**
 * No link and no action — this one exists to be NOTICED. It is the signal a
 * person gets when someone else changes their password, so it must go out on
 * every change including the legitimate ones.
 */
export function passwordChangedEmail(opts: { fullName: string; when: Date; ip?: string | undefined }): RenderedMail {
  const stamp = opts.when.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const from = opts.ip ? ` from ${opts.ip}` : ''
  return {
    category: 'password-changed',
    subject: 'Your fleet dashboard password was changed',
    text:
      `Hello ${opts.fullName},\n\n` +
      `The password on your account was changed on ${stamp}${from}.\n\n` +
      `You were signed out everywhere else as part of the change.\n\n` +
      `If this was not you, contact your organisation's administrator immediately — whoever made the change can currently sign in as you.\n` +
      textFooter(CHANGED_REASON),
    html: shell({
      heading: 'Your password was changed',
      preheader: `Changed on ${stamp}. If this was not you, tell your administrator now.`,
      body:
        para(`Hello ${esc(opts.fullName)},`) +
        para('The password on your account was changed. You were signed out everywhere else as part of the change.') +
        docket([
          ['When', code(stamp)],
          opts.ip ? ['From', code(opts.ip)] : null,
        ]),
      after: note(
        `<strong style="font-weight:600">If this was not you,</strong> contact your organisation's administrator immediately. Whoever made the change can sign in as you.`,
        T.crit,
      ),
      reason: CHANGED_REASON,
    }),
  }
}
/**
 * A technician's repair report — the one mail here that is not about an
 * account.
 *
 * Grouped by OUTCOME and ordered needs_spare, then cannot_fix, then fixing:
 * actionable first. The person reading this has to order a part or take a unit
 * off the road, and neither instruction should sit below a list of things that
 * are already in hand. Units under repair collapse to one line of plates for
 * the same reason — four lines of "in hand, nothing needed" is what makes a
 * report get skimmed instead of read.
 *
 * There is deliberately NO matching "resolved" mail. A technician closing an
 * item is closing their own loop, and mailing the same handlers to say that
 * the thing they were told about is now done doubles the traffic for a fact
 * already on the screen they were sent to.
 */
export function repairAssignmentEmail(opts: {
  assigneeName: string
  assignerName: string
  plate: string
  label: string
  reason?: string | undefined
  /** APP_BASE_URL; blank when the mailer is configured but the origin is not. */
  link?: string | undefined
}): RenderedMail {
  const reasonLine = opts.reason ? `\nReason: ${opts.reason}\n` : ''
  const why = 'You are getting this because a repair task was assigned to you.'
  return {
    category: 'repair-assignment',
    subject: `Repair task assigned: ${opts.plate} — ${opts.label}`,
    text:
      `Hello ${opts.assigneeName},\n\n` +
      `${opts.assignerName} has assigned you a repair task for ${opts.plate} (${opts.label}).${reasonLine}\n` +
      (opts.link ? `Open the task here: ${opts.link}\n` : '') +
      textFooter(why),
    html: shell({
      heading: 'Repair task assigned',
      preheader: `${opts.plate} · ${opts.label}, from ${opts.assignerName}.`,
      body:
        para(`Hello ${esc(opts.assigneeName)},`) +
        para(`${strong(opts.assignerName)} has assigned you a repair task.`) +
        docket([
          ['Unit', code(opts.plate)],
          kv('Fault', opts.label),
          opts.reason ? kv('Reason', opts.reason) : null,
        ]),
      action: opts.link ? { href: opts.link, label: 'Open the task' } : undefined,
      reason: why,
    }),
  }
}

export function repairReportEmail(opts: {
  orgName:        string
  technicianName: string
  reportedAt:     Date
  note?:          string | undefined
  /** APP_BASE_URL; blank when the mailer is configured but the origin is not. */
  link?:          string | undefined
  items: Array<{
    plate:        string
    label:        string
    outcome:      'fixing' | 'needs_spare' | 'cannot_fix'
    sparePart?:   string | undefined
    problemNote?: string | undefined
    /** The technician's estimate of when the unit is back in service. */
    expectedResolutionAt?: Date | undefined
  }>
}): RenderedMail {
  type Item = (typeof opts.items)[number]

  /*
   * The estimate, as a date and nothing else.
   *
   * `toISOString().slice(0, 10)` rather than a locale format: the column is a
   * DATE stored at midnight UTC, and any localisation of it is a chance to
   * render the previous day for a reader east of UTC — which is the whole
   * fleet. The people this mail goes to read ISO dates everywhere else in the
   * product.
   */
  const due = (i: Item): string | null =>
    i.expectedResolutionAt ? i.expectedResolutionAt.toISOString().slice(0, 10) : null

  const spares  = opts.items.filter((i) => i.outcome === 'needs_spare')
  const blocked = opts.items.filter((i) => i.outcome === 'cannot_fix')
  const fixing  = opts.items.filter((i) => i.outcome === 'fixing')
  const stamp   = opts.reportedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

  // The subject carries the triage, because a handler decides whether to open
  // this from the inbox list rather than from the body.
  const clauses: string[] = []
  if (spares.length)  clauses.push(`${spares.length} need${spares.length === 1 ? 's' : ''} spares`)
  if (blocked.length) clauses.push(`${blocked.length} cannot be fixed`)
  const tail = clauses.length > 0 ? ` · ${clauses.join(' · ')}` : ' · all in hand'
  const subject =
    `[${opts.orgName}] Repair report — ${opts.items.length} unit${opts.items.length === 1 ? '' : 's'}${tail}`

  const head = `${opts.technicianName} filed this at ${stamp} for ${opts.orgName}.`

  const textGroup = (title: string, rows: Item[]): string => {
    if (rows.length === 0) return ''
    const body = rows.map((i) => {
      const lines = [`  ${i.plate}   ${i.label}`]
      if (i.sparePart)   lines.push(`             Part: ${i.sparePart}`)
      // Beside the part, because the two are one instruction: order this,
      // and it is wanted by then. A part with no date is a job nobody chases.
      if (due(i))        lines.push(`             Fix date: ${due(i)}`)
      if (i.problemNote) lines.push(`             ${i.problemNote}`)
      return lines.join('\n')
    }).join('\n')
    return `\n${title} (${rows.length})\n${body}\n`
  }

  const htmlGroup = (title: string, colour: string, rows: Item[]): string => {
    if (rows.length === 0) return ''
    return h2(`${title} (${rows.length})`, colour) + list(rows.map((i) =>
      `${code(i.plate)}&nbsp;&nbsp;${esc(i.label)}` +
      (i.sparePart ? sub(`Part: ${esc(i.sparePart)}`, T.warn) : '') +
      (due(i) ? sub(`Fix date: ${esc(due(i)!)}`, T.warn) : '') +
      (i.problemNote ? sub(esc(i.problemNote)) : '')))
  }

  const fixingPlates = fixing.map((i) => i.plate).join(' · ')
  const status: { tone: Tone; label: string } =
    blocked.length ? { tone: 'crit', label: clauses.join(' · ') }
      : spares.length ? { tone: 'warn', label: clauses.join(' · ') }
        : { tone: 'ok', label: 'All in hand' }

  return {
    category: 'repair-report',
    subject,
    text:
      `${head}\n` +
      (opts.note ? `\n${opts.note}\n` : '') +
      textGroup('Spare parts needed', spares) +
      textGroup('Cannot be fixed', blocked) +
      (fixing.length ? `\nBeing fixed (${fixing.length})\n  ${fixingPlates}\n` : '') +
      (opts.link ? `\nOpen the Maintenance screen: ${opts.link}\n` : '') +
      textFooter(REPAIR_REASON),
    html: shell({
      heading: 'Repair report',
      preheader: `${opts.items.length} unit${opts.items.length === 1 ? '' : 's'}${tail}`,
      org: opts.orgName,
      status,
      body:
        para(esc(head)) +
        (opts.note ? para(`<span style="color:${T.muted}">${esc(opts.note)}</span>`) : '') +
        htmlGroup('Spare parts needed', T.warn, spares) +
        htmlGroup('Cannot be fixed', T.crit, blocked) +
        (fixing.length
          ? h2(`Being fixed (${fixing.length})`, T.ok) +
            `<p style="margin:0 0 6px;font-family:${T.mono};font-size:13px;line-height:1.7;color:${T.ink2}">${esc(fixingPlates)}</p>`
          : ''),
      // Only when the origin is configured — the env header is explicit that a
      // mail with a broken link is worse than a mail without one.
      action: opts.link ? { href: opts.link, label: 'Open the Maintenance screen' } : undefined,
      reason: REPAIR_REASON,
    }),
  }
}

// ── Fuel Audit report ───────────────────────────────────────────────────────

/** One signed-off Fuel Audit, as fuel-audit-mail gathers it. */
export interface FuelAuditReport {
  orgName: string
  plate: string
  verdict: 'fixed' | 'unsuccessful'
  signedOffBy: string | null
  signedOffAt: Date
  fixNote: string | null
  recommendation: string | null
  job: {
    raisedAt: Date
    raisedBy: string | null
    technician: string | null
    problemNote: string | null
    fixDate: Date | null
    stages: Array<{ stage: string; at: Date; by: string | null; note: string | null }>
  }
  alerts: Array<{
    beganAt: Date
    litres: number
    cause: string | null
    trail: Array<{ kind: string; at: Date; by: string | null; note: string | null }>
  }>
  inspections: Array<{ component: string; verdict: string; note: string | null; by: string | null; at: Date }>
  parts: Array<{
    name: string; quantity: number; supplier: string | null; costKes: number | null; status: string
    orderedAt: Date; receivedAt: Date | null; fittedAt: Date | null; fixPlannedAt: Date | null
  }>
  link?: string
}

const NAIROBI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})
/** Fleet time, since that is where every reader is. */
const eat = (d: Date): string => `${NAIROBI.format(d)} EAT`
/** DATE columns are midnight UTC: print the day as stored. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

const AUDIT_STAGE: Record<string, string> = {
  pending: 'Pending', spare_outsourced: 'Spare outsourced', fixing: 'Fixing', fixed: 'Fixed', failed: 'Unsuccessful',
}
const AUDIT_ACTION: Record<string, string> = {
  ACCEPTED: 'Taken on', ASSIGNED: 'Assigned', DECLINED: 'Declined', NOTE: 'Note', RECALLED: 'Recalled',
  PROBE_FAULT: 'Found to be a faulty probe', REPAIR_RAISED: 'Repair raised',
  PROBE_FIXED: 'Closed: probe repaired', REPAIR_FAILED: 'Repair unsuccessful',
}
const COMPONENT: Record<string, string> = {
  probe: 'Probe', probe_cable: 'Probe cable', tank_bracket: 'Tank bracket', tracker: 'Tracker', calibration: 'Calibration',
}
const kes = (n: number): string => `KES ${n.toLocaleString('en-KE')}`

/**
 * The Fuel Audit report (operator, 2026-10-01): mailed when an audit is done,
 * with everything on it. See modules/fuel/fuel-audit-mail.
 */
export function fuelAuditReportEmail(r: FuelAuditReport): RenderedMail {
  const outcome = r.verdict === 'fixed' ? 'Probe repaired' : 'Repair unsuccessful'
  const litres = r.alerts.reduce((s, a) => s + a.litres, 0)
  const live = r.parts.filter((p) => p.status !== 'cancelled')
  const cost = live.reduce((s, p) => s + (p.costKes ?? 0), 0)
  const subject = `[${r.orgName}] Fuel Audit done — ${r.plate} · ${outcome}`
  const head = `The Fuel Audit on ${r.plate} is done: ${outcome.toLowerCase()}, signed off by ${r.signedOffBy ?? 'unknown'} on ${eat(r.signedOffAt)}.`

  // ── text ──
  const t: string[] = [head, '', 'SUMMARY']
  t.push(`  Unit: ${r.plate}`, `  Outcome: ${outcome}`,
    `  Fuel alerts found to be a faulty probe: ${r.alerts.length} (${litres.toFixed(1)} L reported lost, not a theft)`)
  if (live.length) t.push(`  Spare parts: ${live.length}${cost ? ` · ${kes(cost)}` : ''}`)
  if (r.fixNote) t.push(`  What was done: ${r.fixNote}`)
  if (r.recommendation) t.push(`  Recommendation: ${r.recommendation}`)
  t.push('', 'FUEL ALERTS')
  r.alerts.forEach((a, i) => {
    t.push(`  ${i + 1}. ${eat(a.beganAt)} · ${a.litres.toFixed(1)} L${a.cause ? ` · ${a.cause}` : ''}`)
    for (const x of a.trail) {
      t.push(`     - ${eat(x.at)} ${AUDIT_ACTION[x.kind] ?? x.kind}${x.by ? ` by ${x.by}` : ''}${x.note ? `: ${x.note}` : ''}`)
    }
  })
  t.push('', 'REPAIR JOB')
  t.push(`  Raised ${eat(r.job.raisedAt)}${r.job.raisedBy ? ` by ${r.job.raisedBy}` : ''}`)
  t.push(`  Technician: ${r.job.technician ?? 'not assigned'}`)
  if (r.job.problemNote) t.push(`  Problem: ${r.job.problemNote}`)
  if (r.job.fixDate) t.push(`  Fix date: ${isoDay(r.job.fixDate)}`)
  for (const s of r.job.stages) {
    t.push(`  - ${AUDIT_STAGE[s.stage] ?? s.stage} · ${eat(s.at)}${s.by ? ` · ${s.by}` : ''}${s.note ? ` · ${s.note}` : ''}`)
  }
  t.push('', 'PROBE INSPECTION')
  if (r.inspections.length === 0) t.push('  Nothing recorded.')
  for (const i of r.inspections) {
    t.push(`  ${COMPONENT[i.component] ?? i.component}: ${i.verdict}${i.note ? ` · ${i.note}` : ''}${i.by ? ` (${i.by}, ${eat(i.at)})` : ''}`)
  }
  t.push('', 'SPARE PARTS')
  if (r.parts.length === 0) t.push('  None ordered.')
  for (const p of r.parts) {
    t.push(`  ${p.quantity > 1 ? `${p.quantity} × ` : ''}${p.name} · ${p.status}${p.supplier ? ` · ${p.supplier}` : ''}${p.costKes != null ? ` · ${kes(p.costKes)}` : ''}`)
    t.push(`     ordered ${isoDay(p.orderedAt)}${p.receivedAt ? `, received ${isoDay(p.receivedAt)}` : ''}${p.fixPlannedAt ? `, fix planned ${isoDay(p.fixPlannedAt)}` : ''}${p.fittedAt ? `, fitted ${isoDay(p.fittedAt)}` : ''}`)
  }
  if (r.link) t.push('', `Open the Fuel Audit: ${r.link}`)
  t.push(textFooter(AUDIT_REASON))

  // ── html ──
  const nothing = (s: string): string => `<p style="margin:0 0 6px;font-size:14px;color:${T.muted}">${esc(s)}</p>`

  const alerts = r.alerts.length
    ? list(r.alerts.map((a) =>
        `${strong(eat(a.beganAt))} · ${esc(a.litres.toFixed(1))} L${a.cause ? ` · ${esc(a.cause)}` : ''}` +
        a.trail.map((x) =>
          sub(`${esc(eat(x.at))} · ${esc(AUDIT_ACTION[x.kind] ?? x.kind)}${x.by ? ` by ${esc(x.by)}` : ''}${x.note ? `: ${esc(x.note)}` : ''}`)).join('')), true)
    : nothing('None.')

  const stages = r.job.stages.length
    ? list(r.job.stages.map((s) =>
        `${esc(AUDIT_STAGE[s.stage] ?? s.stage)} · ${esc(eat(s.at))}${s.by ? ` · ${esc(s.by)}` : ''}${s.note ? sub(esc(s.note)) : ''}`))
    : ''

  const insp = r.inspections.length
    ? docket(r.inspections.map((i) =>
        kv(COMPONENT[i.component] ?? i.component, `${i.verdict}${i.note ? ` · ${i.note}` : ''}${i.by ? ` (${i.by})` : ''}`)))
    : nothing('Nothing recorded.')

  const cell = (html: string, extra = ''): string =>
    `<td style="padding:8px 8px 8px 0;vertical-align:top;font-size:13px;line-height:1.5;color:${T.ink};border-top:1px solid ${T.rule};${extra}">${html}</td>`
  const right = 'text-align:right;padding-right:0;white-space:nowrap'
  const partRows = r.parts.map((p) => {
    const dates = `ordered ${isoDay(p.orderedAt)}${p.receivedAt ? `, received ${isoDay(p.receivedAt)}` : ''}${p.fittedAt ? `, fitted ${isoDay(p.fittedAt)}` : ''}`
    return `<tr>${cell(`${esc(`${p.quantity > 1 ? `${p.quantity} × ` : ''}${p.name}`)}${sub(esc(dates))}`)}${cell(esc(p.status))}${cell(esc(p.supplier ?? '—'))}${cell(p.costKes != null ? esc(kes(p.costKes)) : '—', right)}</tr>`
  }).join('')
  const total = cost
    ? `<tr>${cell('<strong style="font-weight:600">Total (not cancelled)</strong>')}${cell('')}${cell('')}${cell(`<strong style="font-weight:600">${esc(kes(cost))}</strong>`, right)}</tr>`
    : ''
  const th = (s: string, extra = ''): string =>
    `<th align="left" style="padding:0 8px 6px 0;font-size:12px;font-weight:600;color:${T.muted};${extra}">${s}</th>`
  const parts = r.parts.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:2px 0 8px">
        <tr>${th('Part')}${th('Status')}${th('Supplier')}${th('Cost', right)}</tr>
        ${partRows}${total}</table>`
    : nothing('None ordered.')

  const html = shell({
    heading: `Fuel Audit done: ${esc(r.plate)}`,
    preheader: `${outcome} · ${r.alerts.length} alert${r.alerts.length === 1 ? ' was' : 's were'} a faulty probe, not a theft.`,
    org: r.orgName,
    status: { tone: r.verdict === 'fixed' ? 'ok' : 'crit', label: outcome },
    body:
      para(esc(head)) +
      docket([
        ['Unit', code(r.plate)],
        kv('Fuel alerts', `${r.alerts.length} · ${litres.toFixed(1)} L reported lost, found to be a faulty probe (not a theft)`),
        live.length ? kv('Spare parts', `${live.length}${cost ? ` · ${kes(cost)}` : ''}`) : null,
        r.fixNote ? kv('What was done', r.fixNote) : null,
        r.recommendation ? kv('Recommendation', r.recommendation) : null,
      ]) +
      h2('Fuel alerts') + alerts +
      h2('Repair job') +
      docket([
        kv('Raised', `${eat(r.job.raisedAt)}${r.job.raisedBy ? ` by ${r.job.raisedBy}` : ''}`),
        kv('Technician', r.job.technician ?? 'Not assigned'),
        r.job.problemNote ? kv('Problem', r.job.problemNote) : null,
        r.job.fixDate ? kv('Fix date', isoDay(r.job.fixDate)) : null,
      ]) + stages +
      h2('Probe inspection') + insp +
      h2('Spare parts') + parts,
    action: r.link ? { href: r.link, label: 'Open the Fuel Audit' } : undefined,
    reason: AUDIT_REASON,
  })

  return { category: 'fuel-audit-report', subject, text: t.join('\n'), html }
}

/**
 * One event on the Vehicle Support and Repair Workflow (repairs.workflow.notify).
 * Plate, ticket number and stage up front, the detail lines below, a link to
 * the job. In-app notifications and email are the agreed channel (operator,
 * 2026-10-20), so this is the email half of every workflow notice.
 */
export function repairWorkflowEmail(opts: {
  orgName:   string
  headline:  string
  plate:     string
  ticketNo?: string | null | undefined
  stage:     string
  lines:     { label: string; value: string }[]
  critical?: boolean
  link?:     string | undefined
}): RenderedMail {
  const ref = opts.ticketNo ? `${opts.plate} · ${opts.ticketNo}` : opts.plate
  const text = [
    `${opts.headline}`,
    '',
    `Unit: ${opts.plate}`,
    ...(opts.ticketNo ? [`Ticket: ${opts.ticketNo}`] : []),
    `Stage: ${opts.stage}`,
    ...opts.lines.map((l) => `${l.label}: ${l.value}`),
    '',
    `${opts.orgName}`,
    ...(opts.link ? [`Open the job: ${opts.link}`] : []),
  ].join('\n') + '\n' + textFooter(REPAIR_REASON)
  const html = shell({
    heading: esc(opts.headline),
    preheader: `${ref} · ${opts.stage}`,
    org: opts.orgName,
    status: opts.critical ? { tone: 'crit', label: 'Needs attention' } : undefined,
    body: docket([
      ['Unit', code(opts.plate)],
      opts.ticketNo ? ['Ticket', code(opts.ticketNo)] : null,
      kv('Stage', opts.stage),
      ...opts.lines.map((l) => kv(l.label, l.value)),
    ]),
    action: opts.link ? { href: opts.link, label: 'Open the job' } : undefined,
    reason: REPAIR_REASON,
  })
  return { category: 'repair-workflow', subject: `${opts.headline} — ${ref}`, text, html }
}
