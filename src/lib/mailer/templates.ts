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

const shell = (heading: string, body: string, action?: { href: string; label: string }): string => `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h1 style="font-size:19px;margin:0 0 14px">${heading}</h1>
  ${body}
  ${action ? `<p style="margin:22px 0"><a href="${esc(action.href)}" style="display:inline-block;padding:11px 20px;background:#15803d;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600">${esc(action.label)}</a></p>
  <p style="font-size:12px;color:#64748b;margin:0">If the button does not work, paste this into your browser:<br><span style="word-break:break-all">${esc(action.href)}</span></p>` : ''}
</div>`.trim()

/** How long a link lasts, in words rather than a timestamp in another timezone. */
function validFor(expiresAt: Date, now: Date = new Date()): string {
  const hours = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000))
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${Math.round(hours / 24)} days`
}

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
      `If you were not expecting this, you can ignore this message — the account cannot be used until a password is set.\n`,
    html: shell(
      `Set up your ${esc(opts.orgName)} account`,
      `<p style="margin:0 0 10px">Hello ${esc(opts.fullName)},</p>
       <p style="margin:0 0 10px">An account has been created for you at <strong>${esc(opts.orgName)}</strong>${role ? ` as <strong>${esc(opts.roleName!)}</strong>` : ''}. Choose a password to finish setting it up.</p>
       <p style="margin:0;font-size:13px;color:#475569">This link works once and expires in ${window}.</p>`,
      { href: opts.link, label: 'Set your password' },
    ),
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
      `If this was not you, ignore this message. Nothing has changed and your current password still works.\n`,
    html: shell(
      'Reset your password',
      `<p style="margin:0 0 10px">Hello ${esc(opts.fullName)},</p>
       <p style="margin:0 0 10px">Someone asked to reset the password on this account. Choose a new one below.</p>
       <p style="margin:0 0 4px;font-size:13px;color:#475569">This link works once and expires in ${window}.</p>
       <p style="margin:0;font-size:13px;color:#475569">If this was not you, ignore this message — nothing has changed.</p>`,
      { href: opts.link, label: 'Choose a new password' },
    ),
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
      `If this was not you, contact your organisation's administrator immediately — whoever made the change can currently sign in as you.\n`,
    html: shell(
      'Your password was changed',
      `<p style="margin:0 0 10px">Hello ${esc(opts.fullName)},</p>
       <p style="margin:0 0 10px">The password on your account was changed on <strong>${esc(stamp)}</strong>${from ? ` from ${esc(opts.ip!)}` : ''}. You were signed out everywhere else as part of the change.</p>
       <p style="margin:0;font-size:13px;color:#b91c1c">If this was not you, contact your organisation's administrator immediately.</p>`,
    ),
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
  return {
    category: 'repair-assignment',
    subject: `Repair task assigned: ${opts.plate} — ${opts.label}`,
    text:
      `Hello ${opts.assigneeName},\n\n` +
      `${opts.assignerName} has assigned you a repair task for ${opts.plate} (${opts.label}).${reasonLine}\n` +
      (opts.link ? `Open the task here: ${opts.link}\n` : ''),
    html: shell(
      'Repair task assigned',
      `<p style="margin:0 0 10px">Hello ${esc(opts.assigneeName)},</p>
       <p style="margin:0 0 10px"><strong>${esc(opts.assignerName)}</strong> has assigned you a repair task for <strong>${esc(opts.plate)}</strong> (${esc(opts.label)}).</p>
       ${opts.reason ? `<p style="margin:0 0 10px">Reason: ${esc(opts.reason)}</p>` : ''}`,
      opts.link ? { href: opts.link, label: 'Open the task' } : undefined,
    ),
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
    const body = rows.map((i) => `
      <li style="margin:0 0 9px">
        <strong>${esc(i.plate)}</strong> — ${esc(i.label)}
        ${i.sparePart ? `<br><span style="color:#b45309">Part: ${esc(i.sparePart)}</span>` : ''}
        ${due(i) ? `<br><span style="color:#b45309">Fix date: ${esc(due(i)!)}</span>` : ''}
        ${i.problemNote ? `<br><span style="color:#475569;font-size:13px">${esc(i.problemNote)}</span>` : ''}
      </li>`).join('')
    return `<h2 style="font-size:14px;margin:18px 0 8px;color:${colour}">${esc(title)} (${rows.length})</h2>
       <ul style="margin:0;padding-left:18px">${body}</ul>`
  }

  const fixingPlates = fixing.map((i) => i.plate).join(' · ')

  return {
    category: 'repair-report',
    subject,
    text:
      `${head}\n` +
      (opts.note ? `\n${opts.note}\n` : '') +
      textGroup('Spare parts needed', spares) +
      textGroup('Cannot be fixed', blocked) +
      (fixing.length ? `\nBeing fixed (${fixing.length})\n  ${fixingPlates}\n` : '') +
      (opts.link ? `\nOpen the Maintenance screen: ${opts.link}\n` : ''),
    html: shell(
      'Repair report',
      `<p style="margin:0 0 10px">${esc(head)}</p>
       ${opts.note ? `<p style="margin:0 0 10px;color:#475569">${esc(opts.note)}</p>` : ''}
       ${htmlGroup('Spare parts needed', '#b45309', spares)}
       ${htmlGroup('Cannot be fixed', '#b91c1c', blocked)}
       ${fixing.length ? `<h2 style="font-size:14px;margin:18px 0 8px;color:#15803d">Being fixed (${fixing.length})</h2>
       <p style="margin:0;color:#475569">${esc(fixingPlates)}</p>` : ''}`,
      // Only when the origin is configured — the env header is explicit that a
      // mail with a broken link is worse than a mail without one.
      opts.link ? { href: opts.link, label: 'Open the Maintenance screen' } : undefined,
    ),
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

  // ── html ──
  const h2 = (s: string): string =>
    `<h2 style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#475569;margin:20px 0 8px">${esc(s)}</h2>`
  const row = (k: string, v: string): string =>
    `<tr><td style="padding:3px 12px 3px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${esc(v)}</td></tr>`
  const tone = r.verdict === 'fixed' ? '#15803d' : '#b91c1c'

  const alerts = r.alerts.map((a) => {
    const trail = a.trail.map((x) =>
      `<li>${esc(eat(x.at))} — ${esc(AUDIT_ACTION[x.kind] ?? x.kind)}${x.by ? ` by ${esc(x.by)}` : ''}${x.note ? `: ${esc(x.note)}` : ''}</li>`).join('')
    return `<li style="margin:0 0 10px"><strong>${esc(eat(a.beganAt))}</strong> · ${esc(a.litres.toFixed(1))} L${a.cause ? ` · ${esc(a.cause)}` : ''}
      <ul style="margin:4px 0 0;padding-left:16px;color:#475569;font-size:13px">${trail}</ul></li>`
  }).join('')

  const stages = r.job.stages.map((s) =>
    `<li>${esc(AUDIT_STAGE[s.stage] ?? s.stage)} · ${esc(eat(s.at))}${s.by ? ` · ${esc(s.by)}` : ''}${s.note ? `<br><span style="color:#64748b">${esc(s.note)}</span>` : ''}</li>`).join('')

  const insp = r.inspections.length
    ? `<table style="border-collapse:collapse;font-size:13px">${r.inspections.map((i) =>
        row(COMPONENT[i.component] ?? i.component, `${i.verdict}${i.note ? ` · ${i.note}` : ''}${i.by ? ` (${i.by})` : ''}`)).join('')}</table>`
    : '<p style="margin:0;color:#64748b">Nothing recorded.</p>'

  const partRows = r.parts.map((p) => {
    const dates = `ordered ${isoDay(p.orderedAt)}${p.receivedAt ? `, received ${isoDay(p.receivedAt)}` : ''}${p.fittedAt ? `, fitted ${isoDay(p.fittedAt)}` : ''}`
    return `<tr style="border-top:1px solid #e2e8f0">
      <td style="padding:4px 8px 4px 0">${esc(`${p.quantity > 1 ? `${p.quantity} × ` : ''}${p.name}`)}<br><span style="color:#64748b;font-size:12px">${esc(dates)}</span></td>
      <td style="padding:4px 8px">${esc(p.status)}</td>
      <td style="padding:4px 8px">${esc(p.supplier ?? '—')}</td>
      <td style="padding:4px 0;text-align:right">${p.costKes != null ? esc(kes(p.costKes)) : '—'}</td></tr>`
  }).join('')
  const total = cost
    ? `<tr style="border-top:1px solid #e2e8f0"><td colspan="3" style="padding:4px 0;font-weight:600">Total (not cancelled)</td><td style="padding:4px 0;text-align:right;font-weight:600">${esc(kes(cost))}</td></tr>`
    : ''
  const parts = r.parts.length
    ? `<table style="border-collapse:collapse;font-size:13px;width:100%">
        <tr style="text-align:left;color:#64748b"><th style="padding:4px 8px 4px 0">Part</th><th style="padding:4px 8px">Status</th><th style="padding:4px 8px">Supplier</th><th style="padding:4px 0;text-align:right">Cost</th></tr>
        ${partRows}${total}</table>`
    : '<p style="margin:0;color:#64748b">None ordered.</p>'

  const summary = [
    row('Unit', r.plate),
    row('Fuel alerts', `${r.alerts.length} · ${litres.toFixed(1)} L reported lost, found to be a faulty probe (not a theft)`),
    live.length ? row('Spare parts', `${live.length}${cost ? ` · ${kes(cost)}` : ''}`) : '',
    r.fixNote ? row('What was done', r.fixNote) : '',
    r.recommendation ? row('Recommendation', r.recommendation) : '',
  ].join('')
  const job = [
    row('Raised', `${eat(r.job.raisedAt)}${r.job.raisedBy ? ` by ${r.job.raisedBy}` : ''}`),
    row('Technician', r.job.technician ?? 'Not assigned'),
    r.job.problemNote ? row('Problem', r.job.problemNote) : '',
    r.job.fixDate ? row('Fix date', isoDay(r.job.fixDate)) : '',
  ].join('')

  const html = shell(
    `Fuel Audit done — ${esc(r.plate)}`,
    `<p style="margin:0 0 12px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${tone};color:#fff;font-weight:600;font-size:13px">${esc(outcome)}</span></p>
     <p style="margin:0 0 12px">${esc(head)}</p>
     <table style="border-collapse:collapse;font-size:14px">${summary}</table>
     ${h2('Fuel alerts')}<ol style="margin:0;padding-left:18px">${alerts}</ol>
     ${h2('Repair job')}<table style="border-collapse:collapse;font-size:14px">${job}</table>
     <ul style="margin:8px 0 0;padding-left:18px;font-size:13px">${stages}</ul>
     ${h2('Probe inspection')}${insp}
     ${h2('Spare parts')}${parts}`,
    r.link ? { href: r.link, label: 'Open the Fuel Audit' } : undefined,
  )

  return { category: 'fuel-audit-report', subject, text: t.join('\n'), html }
}
