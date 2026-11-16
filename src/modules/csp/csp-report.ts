/**
 * POST /api/v1/csp-report: where browsers send Content-Security-Policy
 * violations for the site.
 *
 * The site's CSP ships in REPORT-ONLY mode first (raitrack deploy/web.conf):
 * the page loads tiles, fonts, a dashcam player with a WASM decoder and a
 * WebSocket from several hosts, and a policy written from a code search would
 * break one of them for real users. Report-only blocks nothing; this endpoint
 * collects what an enforced policy WOULD have blocked, so the policy is
 * tightened from evidence before it is enforced.
 *
 * Two body formats arrive:
 *   · `report-uri`  → Content-Type application/csp-report, `{ "csp-report": {...} }`
 *   · `report-to`   → Content-Type application/reports+json, `[{ type, body }]`
 *
 * Each distinct (directive, blocked, page) is logged once per process, then again
 * at 10, 100, 1000… sightings, so a noisy page cannot flood the log. Only
 * origins and paths are kept: never query strings, which can carry tokens.
 */
import type { RequestHandler } from 'express'
import { logger } from '../../lib/logger.js'

export const CSP_REPORT_TYPES = ['application/csp-report', 'application/reports+json', 'application/json']

export interface CspViolation {
  directive: string
  blocked: string
  page: string
  source: string | null
  line: number | null
  disposition: string | null
}

/** An origin for a URL; a keyword (inline, eval, data, blob, wasm-eval) as given; '' otherwise. */
function where(v: unknown): string {
  if (typeof v !== 'string' || v === '') return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v.split(/[:?#]/)[0]!.slice(0, 40)
  try {
    const u = new URL(v)
    return u.origin
  } catch { return '' }
}

/** Origin + path, no query or fragment. */
function page(v: unknown): string {
  if (typeof v !== 'string') return ''
  try {
    const u = new URL(v)
    return (u.origin + u.pathname).slice(0, 200)
  } catch { return '' }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Every violation in a report body, in either format; [] for anything else. */
export function parseCspReports(body: unknown): CspViolation[] {
  const out: CspViolation[] = []
  const add = (r: Record<string, unknown>, legacy: boolean) => {
    const directive = str(legacy ? (r['effective-directive'] || r['violated-directive']) : r.effectiveDirective).split(' ')[0]!
    if (!directive) return
    out.push({
      directive: directive.slice(0, 60),
      blocked: where(legacy ? r['blocked-uri'] : r.blockedURL),
      page: page(legacy ? r['document-uri'] : r.documentURL),
      source: page(legacy ? r['source-file'] : r.sourceFile) || null,
      line: num(legacy ? r['line-number'] : r.lineNumber),
      disposition: str(r.disposition) || null,
    })
  }
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 50)) {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'csp-violation') {
        const b = (item as { body?: unknown }).body
        if (b && typeof b === 'object') add(b as Record<string, unknown>, false)
      }
    }
  } else if (body && typeof body === 'object' && 'csp-report' in body) {
    const r = (body as Record<string, unknown>)['csp-report']
    if (r && typeof r === 'object') add(r as Record<string, unknown>, true)
  }
  return out
}

const seen = new Map<string, number>()
const MAX_KEYS = 2000

/** Whether this sighting should be logged: the first, then the 10th, 100th, 1000th… */
export function shouldLog(v: CspViolation): { log: boolean; count: number } {
  const key = `${v.directive}|${v.blocked}|${v.page}`
  if (!seen.has(key) && seen.size >= MAX_KEYS) seen.clear()
  const count = (seen.get(key) ?? 0) + 1
  seen.set(key, count)
  return { log: /^10*$/.test(String(count)), count }
}

export const cspReportHandler: RequestHandler = (req, res) => {
  for (const v of parseCspReports(req.body)) {
    const { log, count } = shouldLog(v)
    if (log) logger.warn({ csp: v, count }, 'csp violation')
  }
  res.status(204).end()
}
