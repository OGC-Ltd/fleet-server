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

import { emitDashboardFeed } from './sse.js'

interface FeedSource {
  vehicleId:     string
  plate:         string
  driverName?:   string | null
  capturedAt:    string
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

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const tonnes = (kg: number | null) => kg && kg > 0 ? `${(kg / 1000).toFixed(1)}t ` : ''

let feedSeq = 0

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
      text: `ALERT: ${who} detected at ${Math.round(p.speedKmh ?? 0)} km/h en route to ${to}. Speed limit 80 km/h. Driver notified.`,
    })
  }
  if (p.flags.fuelInconsistency && !st.fuelInconsistency) {
    items.push({
      type: 'critical',
      text: `CRITICAL: ${who} — sudden fuel level drop detected near ${from === 'base' ? to : from}. Possible theft. Security alerted.`,
    })
  }

  st.phase             = p.phase
  st.overspeeding      = p.flags.overspeeding
  st.fuelInconsistency = p.flags.fuelInconsistency
  prev.set(p.vehicleId, st)

  for (const item of items) {
    emitDashboardFeed(orgId, {
      id:        `feed-${now}-${feedSeq++}`,
      time:      at,
      ts:        new Date(now).toISOString(),
      vehicleId: p.vehicleId,
      ...item,
    })
  }
}
