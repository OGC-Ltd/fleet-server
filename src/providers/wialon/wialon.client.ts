/**
 * Wialon Hosting API client.
 *
 * Thin session wrapper over the Remote API (`/wialon/ajax.html?svc=…`). Owns
 * the login and the `sid` every subsequent call needs, and re-authenticates
 * transparently when the session lapses.
 *
 * Two behaviours drive the design:
 *
 *  • A session goes stale after roughly five minutes idle. Long-lived callers
 *    (the poller) keep it warm by calling continuously; short-lived ones (the
 *    sync scripts) simply log in, do their work and exit. Either way an
 *    `error: 1` (invalid session) triggers one silent re-login and retry, so a
 *    lapse never surfaces as a failure.
 *
 *  • Wialon answers HTTP 200 for everything, including failures — errors are
 *    `{"error": N}` in the body. Every call therefore has to inspect the
 *    payload rather than the status code.
 */

import { logger } from '../../lib/logger.js'

const DEFAULT_BASE = 'https://hst-api.wialon.com'

/** Wialon error codes worth naming; the rest are reported numerically. */
const ERRORS: Record<number, string> = {
  1: 'Invalid session',
  2: 'Invalid service name',
  4: 'Invalid input',
  5: 'Error performing request',
  7: 'Access denied',
  8: 'Invalid user name or password',
  1003: 'Only one request at a time is allowed',
}

export class WialonError extends Error {
  constructor(public readonly code: number, svc: string) {
    super(`Wialon ${svc} failed: ${ERRORS[code] ?? `error ${code}`} (${code})`)
    this.name = 'WialonError'
  }
}

export interface WialonPosition {
  t: number   // unix SECONDS (not ms)
  y: number   // latitude
  x: number   // longitude
  z?: number  // altitude, m
  s?: number  // speed, km/h
  c?: number  // course/heading, degrees
  sc?: number // satellite count
}

export interface WialonUnit {
  id:   number
  nm:   string                    // unit name — the only human identifier available
  cls?: number
  uid?: string                    // IMEI, when the account exposes it
  hw?:  string | number           // hardware type
  pos?: WialonPosition | null     // LAST KNOWN position; may be weeks old
  flds?: Record<string, { n: string; v: string }>
}

export class WialonClient {
  private sid: string | null = null
  private loginPromise: Promise<string> | null = null

  constructor(
    private readonly token: string,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {
    if (!token) throw new Error('Wialon token is not configured')
  }

  /** Authenticate and cache the session id. Concurrent callers share one login. */
  async login(): Promise<string> {
    if (this.sid) return this.sid
    if (!this.loginPromise) {
      this.loginPromise = this.request<{ eid: string; au: string; error?: number }>(
        'token/login', { token: this.token }, null,
      ).then((res) => {
        this.sid = res.eid
        logger.info({ account: res.au, base: this.baseUrl }, 'Wialon session opened')
        return res.eid
      }).finally(() => { this.loginPromise = null })
    }
    return this.loginPromise
  }

  /**
   * Call a service, re-authenticating once if the session has lapsed.
   * Wialon serialises requests per session, so callers must not run these
   * concurrently on one client (error 1003).
   */
  async call<T>(svc: string, params: unknown): Promise<T> {
    const sid = await this.login()
    try {
      return await this.request<T>(svc, params, sid)
    } catch (err) {
      if (err instanceof WialonError && err.code === 1) {
        this.sid = null
        logger.warn({ svc }, 'Wialon session expired — re-authenticating')
        const fresh = await this.login()
        return this.request<T>(svc, params, fresh)
      }
      throw err
    }
  }

  private async request<T>(svc: string, params: unknown, sid: string | null): Promise<T> {
    const qs = new URLSearchParams({ svc, params: JSON.stringify(params) })
    if (sid) qs.set('sid', sid)

    const res = await fetch(`${this.baseUrl}/wialon/ajax.html?${qs.toString()}`)
    if (!res.ok) throw new Error(`Wialon ${svc} responded HTTP ${res.status}`)

    const body = await res.json() as T & { error?: number }
    // Wialon reports failures in the body with HTTP 200.
    if (body && typeof body === 'object' && typeof body.error === 'number' && body.error !== 0) {
      throw new WialonError(body.error, svc)
    }
    return body
  }

  /**
   * Every unit the account can see, with its last known position.
   *
   * flags: 1 base | 8 custom fields | 0x400 last position.
   */
  async listUnits(): Promise<WialonUnit[]> {
    const res = await this.call<{ items?: WialonUnit[]; totalItemsCount?: number }>(
      'core/search_items',
      {
        spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1,
        flags: 1 | 8 | 0x400,
        from: 0,
        to: 0xFFFFFFFF,
      },
    )
    return res.items ?? []
  }

  /**
   * Subscribe this session to position updates for the given units.
   *
   * `avl_evts` returns ONLY what the session is subscribed to — an empty
   * response almost always means the flags are wrong rather than that nothing
   * moved. mode 1 = add these units to the current subscription.
   *
   * flags 0x400 = last known position, matching what listUnits() requests.
   */
  async subscribePositions(unitIds: number[]): Promise<void> {
    if (unitIds.length === 0) return
    await this.call('core/update_data_flags', {
      spec: [{ type: 'col', data: unitIds, flags: 1 | 0x400, mode: 1 }],
    })
  }

  /**
   * Everything that changed since the previous call.
   *
   * Also serves as the session keepalive — Wialon drops an idle session after
   * roughly five minutes, and a steady `avl_evts` loop is the documented way
   * to hold it open.
   *
   * Shape: `{ tm, events: [{ i: unitId, t: 'm'|'u'|'d', d: { pos } }] }`.
   * Only `u` (unit data changed) carries a position we care about; `m` is a
   * raw message and `d` a deletion.
   */
  async pollEvents(): Promise<Array<{ unitId: number; pos: WialonPosition }>> {
    // NOTE: avl_evts is its OWN endpoint — /avl_evts?sid=… — not an
    // ajax.html service. Calling it as `svc=avl_evts` returns error 2
    // ("invalid service name").
    const sid = await this.login()
    const res = await this.fetchEvents(sid)

    const out: Array<{ unitId: number; pos: WialonPosition }> = []
    for (const e of res.events ?? []) {
      const pos = e.d?.pos
      if (!pos || !Number.isFinite(pos.y) || !Number.isFinite(pos.x)) continue

      // Unlike search_items, an avl_evts position often omits `t`. The
      // response's top-level `tm` is when Wialon registered the batch, so it
      // stands in — without it every delta produced an Invalid Date and was
      // rejected at the database.
      const t = Number.isFinite(pos.t) ? pos.t : res.tm
      if (!Number.isFinite(t)) continue     // no defensible timestamp — drop it

      out.push({ unitId: e.i, pos: { ...pos, t: t as number } })
    }
    return out
  }

  /** GET /avl_evts, re-authenticating once if the session has lapsed. */
  private async fetchEvents(sid: string, retry = true): Promise<{
    tm?: number
    events?: Array<{ i: number; t: string; d?: { pos?: WialonPosition } }>
    error?: number
  }> {
    const res = await fetch(`${this.baseUrl}/avl_evts?sid=${encodeURIComponent(sid)}`)
    if (!res.ok) throw new Error(`Wialon avl_evts responded HTTP ${res.status}`)
    const body = await res.json() as { error?: number; events?: unknown }

    if (typeof body.error === 'number' && body.error !== 0) {
      if (body.error === 1 && retry) {
        this.sid = null
        logger.warn('Wialon session expired during avl_evts — re-authenticating')
        return this.fetchEvents(await this.login(), false)
      }
      throw new WialonError(body.error, 'avl_evts')
    }
    return body as { tm?: number; events?: Array<{ i: number; t: string; d?: { pos?: WialonPosition } }> }
  }

  /**
   * Render dates/reports in the fleet's timezone rather than the API default
   * of UTC. Only affects Wialon-side formatting (reports); raw `pos.t` values
   * are always unix seconds and unambiguous.
   */
  async setLocale(timezone = 0x0000000 | 3, language = 'en'): Promise<void> {
    await this.call('render/set_locale', { tzOffset: timezone, language })
  }

  /** Best-effort logout; a dropped session expires on its own anyway. */
  async logout(): Promise<void> {
    if (!this.sid) return
    try { await this.call('core/logout', {}) } catch { /* nothing to salvage */ }
    this.sid = null
  }
}

/** Position → the platform's telemetry shape. `pos.t` is SECONDS. */
export function positionToTelemetry(pos: WialonPosition) {
  return {
    capturedAt:     new Date(pos.t * 1000),
    lat:            pos.y,
    lng:            pos.x,
    altitudeM:      pos.z ?? null,
    speedKmh:       pos.s ?? null,
    headingDeg:     pos.c ?? null,
    satelliteCount: pos.sc ?? null,
    // `pos` carries no ignition channel and the column is NOT NULL, so this is
    // a floor, not the truth: moving ⇒ engine on is safe, but stationary does
    // NOT imply engine off — an idling vehicle reads as off here. Real ignition
    // state needs a named sensor channel; wire one in before trusting
    // engine-hours or idling figures.
    engineOn:       (pos.s ?? 0) > 0,
  }
}
