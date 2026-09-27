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
import type { WialonSensor } from './wialon.sensors.js'
import { BILLING_PROPS_FLAG } from './wialon.account.js'

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
  /** Configured sensors (fuel probes, ignition, voltages) — see wialon.sensors. */
  sens?: Record<string, WialonSensor>
  /** Last message; `p` holds the raw parameter values the sensors read. */
  lmsg?: { t?: number; p?: Record<string, unknown> } | null
  /** Total mileage counter, km. Requires flag 0x2000. */
  cnm_km?: number
  /** Engine-hours counter. Requires flag 0x2000. */
  cneh?: number
  /**
   * Wialon's OWN connection verdict: 1 = online, 0 = offline. Requires flag
   * 0x200000.
   *
   * This is the authority on whether a unit is connected, and it is not the
   * same as "sent a message recently". Measured against the live account, a
   * 15-minute last-message window disagreed with Wialon on 28 of 224 units —
   * 25 of them units Wialon considered offline.
   */
  netconn?: number
  /**
   * Id of the Wialon ACCOUNT that owns this unit — which customer's fleet it
   * is. Requires flag 0x4, and equals that account's resource id. See
   * wialon.account: this is the only reliable org boundary on a token that can
   * see eight customers.
   */
  bact?: number
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
   * Every unit the account can see, with its last known position, its
   * configured sensors, and the last message's raw parameters.
   *
   * `accountId` restricts the result to units OWNED by that Wialon account —
   * see wialon.account for why anything writing to one organisation's registry
   * must pass it. Omitted, this returns every unit the token can see, which
   * today spans eight customers; that is what the live poller wants, because
   * Sukari's vehicles are bound to Wialon units under a different account.
   *
   * flags: 1 base | 8 custom fields | 0x400 last position + last message
   *        | 0x1000 sensors | 0x2000 counters | 0x200000 connection state.
   *        The sensors and `lmsg.p` make a fuel reading possible; 0x2000 is
   *        what returns `cnm_km` (total mileage) and `cneh` (engine hours) —
   *        without it they are absent, which reads as zero rather than as an
   *        error. 0x200000 is the ONLY flag that returns `netconn`; it was
   *        found by probing all 32 bits against the live account, because the
   *        published flag tables do not list it.
   */
  async listUnits(accountId?: number): Promise<WialonUnit[]> {
    const res = await this.call<{ items?: WialonUnit[]; totalItemsCount?: number }>(
      'core/search_items',
      {
        spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1,
        // 0x4 only when an account filter is asked for, so the live poller's
        // sweep payload is unchanged.
        flags: 1 | 8 | 0x400 | 0x1000 | 0x2000 | 0x200000 | (accountId != null ? BILLING_PROPS_FLAG : 0),
        from: 0,
        to: 0xFFFFFFFF,
      },
    )
    const items = res.items ?? []
    if (accountId == null) return items

    // Wialon has no server-side filter on `bact` — `propName: 'sys_billing_account'`
    // is not a searchable property — so the sweep comes back whole and is
    // narrowed here. The cost is bandwidth, not correctness.
    const mine = items.filter(u => u.bact === accountId)
    if (items.length > 0 && mine.length === 0) {
      throw new Error(
        `No units belong to Wialon account ${accountId}, though ${items.length} units are visible. ` +
        `Refusing to continue: either the account id is wrong or the token lost access to it.`,
      )
    }
    return mine
  }

  /**
   * Connection state only — every unit's `netconn`, nothing else.
   *
   * Deliberately its own call rather than a field of the full sweep. Measured
   * against the live account: 19 KB / 315 ms here versus 2.7 MB / 874 ms for
   * the full sweep, so this can run several times per sweep interval and keep
   * the online/offline verdict fresh, which is the whole point — a unit that
   * dropped 90 seconds ago should not still be shown connected.
   */
  async listConnectionStates(): Promise<Array<{ id: number; netconn?: number }>> {
    const res = await this.call<{ items?: Array<{ id: number; netconn?: number }> }>(
      'core/search_items',
      {
        spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1,
        flags: 1 | 0x200000,
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
   * Shape: `{ tm, events: [{ i: unitId, t: 'm'|'u'|'d', d }] }`.
   *
   * On this subscription every event arrives as `t: 'm'`, and `d` is the whole
   * raw message: `t, f, tp, pos, lc, rt, p` (probed live on 2026-09-27, 60 of 60
   * events). So `d.p` carries the same raw parameters the sweep reads from
   * `lmsg.p`, for THIS message — which is what lets the accelerometer be read
   * per fix instead of once a sweep. It is returned as `params`.
   *
   * `d.t` is the message's own time. It is not used for the timestamp yet: on
   * units that deliver in batches it runs a median 104 s (p90 586 s) behind the
   * `tm` fallback below, and switching to it would move every delta's
   * captured_at and stop same-batch messages collapsing into one row. That is
   * worth doing, but as its own change.
   */
  async pollEvents(): Promise<Array<{ unitId: number; pos: WialonPosition; params: Record<string, unknown> | null }>> {
    // NOTE: avl_evts is its OWN endpoint — /avl_evts?sid=… — not an
    // ajax.html service. Calling it as `svc=avl_evts` returns error 2
    // ("invalid service name").
    const sid = await this.login()
    const res = await this.fetchEvents(sid)

    const out: Array<{ unitId: number; pos: WialonPosition; params: Record<string, unknown> | null }> = []
    for (const e of res.events ?? []) {
      const pos = e.d?.pos
      if (!pos || !Number.isFinite(pos.y) || !Number.isFinite(pos.x)) continue

      // Unlike search_items, an avl_evts position often omits `t`. The
      // response's top-level `tm` is when Wialon registered the batch, so it
      // stands in — without it every delta produced an Invalid Date and was
      // rejected at the database.
      const t = Number.isFinite(pos.t) ? pos.t : res.tm
      if (!Number.isFinite(t)) continue     // no defensible timestamp — drop it

      const p = e.d?.p
      const params = p != null && typeof p === 'object' && !Array.isArray(p) ? p : null
      out.push({ unitId: e.i, pos: { ...pos, t: t as number }, params })
    }
    return out
  }

  /** GET /avl_evts, re-authenticating once if the session has lapsed. */
  private async fetchEvents(sid: string, retry = true): Promise<{
    tm?: number
    events?: Array<{ i: number; t: string; d?: { pos?: WialonPosition; p?: Record<string, unknown>; t?: number } }>
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
    return body as { tm?: number; events?: Array<{ i: number; t: string; d?: { pos?: WialonPosition; p?: Record<string, unknown>; t?: number } }> }
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
