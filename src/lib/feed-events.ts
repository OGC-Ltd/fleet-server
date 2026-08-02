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
  const who   = `${p.plate} · ${p.driverName ?? 'Unassigned'}`
  const now   = Date.parse(p.capturedAt) || Date.now()
  const at    = clock(now)
  const from  = p.leg?.from ?? 'base'
  const to    = p.leg?.to ?? 'destination'
  const eta   = p.leg?.plannedArrivalMs ? ` ETA ${clock(p.leg.plannedArrivalMs)}.` : ''
  const cargo = `${tonnes(p.cargoWeightKg)}${p.cargoDesc || 'cargo'}`

  // ── phase transitions ──────────────────────────────────────────────────
  if (st.phase && p.phase && p.phase !== st.phase) {
    switch (p.phase) {
      case 'TO_DEPOT':
        items.push({ type: 'info', text: `${who} departed ${from}. Cargo: ${cargo} bound for ${to}.${eta}` })
        break
      case 'TO_FARM':
        items.push({ type: 'info', text: `${who} dispatched to ${to} to collect raw sugarcane.${eta}` })
        break
      case 'LOADING':
        items.push({ type: 'success', text: `${who} arrived at ${to} at ${at}. Loading raw sugarcane.` })
        break
      case 'OFFLOADING':
        items.push({ type: 'success', text: `${who} arrived at ${to} at ${at}. Offloading ${cargo}.` })
        break
      case 'UNLOADING':
        items.push({ type: 'success', text: `${who} arrived at ${to} at ${at}. Offloading ${tonnes(p.cargoWeightKg)}raw sugarcane.` })
        break
      case 'TO_INDUSTRY':
        items.push(st.phase === 'LOADING'
          ? { type: 'info', text: `${who} loaded ${cargo} at ${from} — hauling to ${to}.${eta}` }
          : { type: 'info', text: `${who} completed offloading — returning to ${to}.${eta}` })
        break
      case 'DWELL':
        items.push({ type: 'info', text: `${who} offloading complete at ${to}. Driver rest stop before the return leg.` })
        break
      case 'TO_GARAGE':
        items.push({ type: 'warning', text: `${who} redirected to ${to} — scheduled service due.` })
        break
      case 'FROM_GARAGE':
        items.push({ type: 'success', text: `${who} service completed. Returning to base.` })
        break
      case 'AT_INDUSTRY':
      case 'AT_PARKING':
        if (st.phase === 'TO_INDUSTRY' || st.phase === 'TO_PARKING') {
          items.push({ type: 'success', text: `${who} arrived back at ${to} at ${at}. Trip complete.` })
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
      text: `ALERT: ${who} detected at ${Math.round(p.speedKmh ?? 0)} km/h en route to ${to}. Speed limit 80 km/h.`,
    })
  }
  if (p.flags.fuelInconsistency && !st.fuelInconsistency) {
    items.push({
      type: 'critical',
      // Same as above: no "Security alerted." until an escalation path exists.
      text: `CRITICAL: ${who} — sudden fuel level drop detected near ${from === 'base' ? to : from}. Possible theft.`,
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
