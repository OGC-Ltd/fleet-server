/**
 * Fault kinds that come from the tracker's own status codes in Wialon (operator, 2026-11-27): they
 * live on the Maintenance "Wialon" view and in a unit's fault history, and stay out of everything
 * the system already counts (the Malfunction tab and its strip, Analytics, the Fuel Consumption
 * Rate note, vehicle insights) unless a caller asks for them by name.
 *
 * `fuel_probe_fault` (the probe's 4095 / 6500 / 7000 codes, live since 2026-11-26) is a tracker
 * code too, but stays where it is for now (operator: "wialon/system, we will change that later"):
 * it is NOT in this list, so the system views keep it, and the Wialon view asks for it by name.
 */
export const WIALON_ONLY_FAULT_KINDS = ['fuel_probe_status', 'fuel_probe_battery', 'gnss_fault'] as const

/** What the Wialon view lists: the Wialon-only kinds and the shared one. */
export const WIALON_VIEW_FAULT_KINDS = [...WIALON_ONLY_FAULT_KINDS, 'fuel_probe_fault'] as const
