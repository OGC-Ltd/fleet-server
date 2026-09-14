// Live-feed derivation — turns the stream of per-vehicle position payloads
// into the human activity feed the Fleet page shows (dispatches, arrivals,
// offloading, overspeeding, fuel theft), replacing the old static mock feed.
//
// Items match the mock feed's shape exactly ({ time, type, text }) so the
// panel renders them unchanged:
//   info     — dispatches, en-route progress, return legs
//   success  — arrivals (with the arrival time), completed loads/offloads
//   warning  — overspeeding, garage redirects
//   critical — fuel inconsistency / suspected theft
//
// Events are detected as PHASE TRANSITIONS between consecutive frames of the
// same vehicle (plus rising edges on the alert flags), buffered per org in
// sse.ts and replayed to newly connected clients.

import { publishNotification } from './notifications/notification.store.js'
import { overspeedLimitFor } from './derived-alerts.js'

interface FeedSource {
  vehicleId:     string
  plate:         string
  driverName?:   string | null
  capturedAt:    string
  lat:           number | null
  lng:           number | null
  speedKmh:      number | null
  cargoWeightKg: number | null
  cargoDesc:     string | null
  /**
   * Drives the limit quoted in the overspeeding line. Optional because the
   * db-follower path can be missing it; `overspeedLimitFor(null)` then returns
   * the fleet-wide limit, which is the same answer the text used to hardcode.
   */
  vehicleType:   string | null
  phase:         string | null
  leg:           { from?: string; to?: string; plannedArrivalMs?: number } | null
  flags:         { overspeeding: boolean; fuelInconsistency: boolean }
}

interface PrevState {
  phase:           string | null
  overspeeding:    boolean
  fuelInconsistency: boolean
  lastOverspeedFeedAt: number
}
const prev = new Map<string, PrevState>()

const OVERSPEED_FEED_COOLDOWN_MS = 10 * 60_000

// Clock strings are baked into the feed TEXT, so they must be minted in the
// fleet's operating timezone — bare getHours() uses the server's TZ, and the
// production box runs UTC, stamping every event 3 h behind Kenyan wall time.
// (Clients render the standalone `time` field from `ts` in their own TZ.)
const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})
const clock = (ms: number) => clockFmt.format(ms)
const tonnes = (kg: number | null) => kg && kg > 0 ? `${(kg / 1000).toFixed(1)}t ` : ''

export function deriveFeedEvents(orgId: string, p: FeedSource): void {
  const st = prev.get(p.vehicleId) ?? {
    phase: null, overspeeding: false, fuelInconsistency: false, lastOverspeedFeedAt: 0,
  }

  const items: { type: 'info' | 'success' | 'warning' | 'critical'; text: string }[] = []
  // No "· Unassigned". A unit with no driver on it is a unit with no driver on
  // it; naming the absence puts a word in every sentence that carries nothing.
  const who   = p.driverName ? `${p.plate} · ${p.driverName}` : p.plate
  const now   = Date.parse(p.capturedAt) || Date.now()
  const at    = clock(now)
  // NULL when the leg does not name one, and every clause below is written to
  // be absent rather than to fall back. The literals used to be 'base' and
  // 'destination', which produced "detected at 95 km/h en route to
  // destination" — a sentence that asserts a place and then declines to name
  // it. Read off the live feed on 2026-09-14, 59 of them in one window.
  const from  = p.leg?.from ?? null
  const to    = p.leg?.to ?? null
  const toward   = to   ? ` to ${to}`     : ''
  const bound    = to   ? ` bound for ${to}` : ''
  const arrivedAt = to  ? ` at ${to}`     : ''
  const eta   = p.leg?.plannedArrivalMs
    ? ` The estimated arrival is ${clock(p.leg.plannedArrivalMs)}.`
    : ''
  const cargo = `${tonnes(p.cargoWeightKg)}${p.cargoDesc || 'cargo'}`

  // ── phase transitions ──────────────────────────────────────────────────
  if (st.phase && p.phase && p.phase !== st.phase) {
    switch (p.phase) {
      case 'TO_DEPOT':
        items.push({ type: 'info', text: `${who} departed${from ? ` from ${from}` : ''} carrying ${cargo}${bound}.${eta}` })
        break
      case 'TO_FARM':
        items.push({ type: 'info', text: `${who} was dispatched${toward} to collect raw sugarcane.${eta}` })
        break
      case 'LOADING':
        items.push({ type: 'success', text: `${who} arrived${arrivedAt} at ${at} and is loading raw sugarcane.` })
        break
      case 'OFFLOADING':
        items.push({ type: 'success', text: `${who} arrived${arrivedAt} at ${at} and is offloading ${cargo}.` })
        break
      case 'UNLOADING':
        items.push({ type: 'success', text: `${who} arrived${arrivedAt} at ${at} and is offloading ${tonnes(p.cargoWeightKg)}raw sugarcane.` })
        break
      case 'TO_INDUSTRY':
        items.push(st.phase === 'LOADING'
          ? { type: 'info', text: `${who} loaded ${cargo}${from ? ` at ${from}` : ''} and is hauling${toward}.${eta}` }
          : { type: 'info', text: `${who} completed offloading and is returning${toward}.${eta}` })
        break
      case 'DWELL':
        items.push({ type: 'info', text: `${who} completed offloading${arrivedAt}. The driver is resting before the return leg.` })
        break
      case 'TO_GARAGE':
        items.push({ type: 'warning', text: `${who} was redirected${toward}, where a scheduled service is due.` })
        break
      case 'FROM_GARAGE':
        items.push({ type: 'success', text: `${who} has completed its service and is returning to base.` })
        break
      case 'AT_INDUSTRY':
      case 'AT_PARKING':
        if (st.phase === 'TO_INDUSTRY' || st.phase === 'TO_PARKING') {
          items.push({ type: 'success', text: `${who} arrived back${arrivedAt} at ${at}. The trip is complete.` })
        }
        break
    }
  }

  // ── alert-flag rising edges ────────────────────────────────────────────
  if (p.flags.overspeeding && !st.overspeeding && now - st.lastOverspeedFeedAt > OVERSPEED_FEED_COOLDOWN_MS) {
    st.lastOverspeedFeedAt = now
    items.push({
      type: 'warning',
      // No "Driver notified." claim — no notify/escalate mechanism exists yet.
      // The limit is READ, not written in. It was the literal 80 until this
      // became the only place an overspeeding line is produced; a fleet that
      // sets OVERSPEED_LIMIT_BY_TYPE=TRACTOR:50 would otherwise be told a
      // tractor at 55 km/h broke an 80 limit, which is both wrong and the exact
      // figure someone would dispute the alert with.
      text: `ALERT: ${who} was recorded at ${Math.round(p.speedKmh ?? 0)} km/h`
          + `${to ? ` en route to ${to}` : ''}. `
          + `The speed limit is ${overspeedLimitFor(p.vehicleType ?? null)} km/h.`,
    })
  }
  if (p.flags.fuelInconsistency && !st.fuelInconsistency) {
    const near = from ?? to
    items.push({
      type: 'critical',
      // Same as above: no "Security alerted." until an escalation path exists.
      text: `CRITICAL: ${who} recorded a sudden fuel level drop`
          + `${near ? ` near ${near}` : ''}. This may be theft.`,
    })
  }

  st.phase             = p.phase
  st.overspeeding      = p.flags.overspeeding
  st.fuelInconsistency = p.flags.fuelInconsistency
  prev.set(p.vehicleId, st)

  items.forEach((item, idx) => {
    publishNotification({
      orgId,
      // Derived entirely from the FRAME — its captured time, its vehicle, and
      // the position of this item within the frame. It used to end in a
      // process-global counter, which made the id depend on when the frame was
      // processed rather than on what it contained: re-processing one frame
      // (a restart replaying it, a redelivery) minted brand-new ids, so the
      // duplicate was invisible to every dedupe downstream — Postgres' unique
      // feedId included. Same uniqueness guarantee as the counter had, since
      // one capturedAt plus one vehicle IS one frame and the indices within it
      // are distinct; the difference is that it now repeats.
      id:        `feed-${now}-${p.vehicleId}-${idx}`,
      source:    'telemetry',
      severity:  item.type,
      text:      item.text,
      at:        new Date(now),
      plate:     p.plate,
      vehicleId: p.vehicleId,
      // Position at the moment of the event — the feed is global across orgs,
      // so clients can't resolve coordinates from their own org's fleet list
      // (powers the WhatsApp share's maps pin). No Postgres column; see
      // notification.store's `extra`.
      extra:     { lat: p.lat, lng: p.lng },
    })
  })
}
