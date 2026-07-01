/**
 * Controltech EA raw API wire types.
 *
 * These mirror the actual JSON shape returned by the Controltech REST endpoint
 * GET /api/v2/devices/snapshot.  When integrating the live service, the
 * ControltechLiveAdapter should decode the HTTP response into these types
 * before passing them to the shared normaliser.
 */

export type CtDoorState = 0 | 1 | 2   // 0 = closed, 1 = open, 2 = ajar

export interface CtDeviceSnapshot {
  imei:            string           // primary device identifier
  device_id:       string           // human-readable alias (maps to our deviceId)
  timestamp_utc:   string           // ISO-8601 capture time
  lat:             number | null
  lng:             number | null
  altitude_m:      number | null
  heading_deg:     number | null
  gps_accuracy_m:  number | null
  gps_fix:         number           // 0 = no fix, 1 = GPS, 2 = DGPS
  sat_count:       number
  speed_kmh:       number
  ignition:        0 | 1
  engine_on:       0 | 1
  door_state:      CtDoorState
  panic:           0 | 1
  fuel_level_ml:   number | null
  fuel_used_ml:    number | null
  cargo_weight_kg: number | null
  battery_v:       number
  engine_temp_c:   number | null   // OBD-II engine coolant temperature
  oil_level_pct:   number | null   // OBD-II oil level as % of max fill
  network:         'GSM' | '3G' | '4G' | '5G'
  signal_pct:      number           // 0–100
  odometer_km:     number
  io_inputs: {
    din1: 0 | 1                     // door contact
    din2: 0 | 1                     // panic / duress
    din3: 0 | 1                     // PTO (power take-off)
    din4: 0 | 1                     // immobiliser
  }
  io_outputs: {
    dout1: 0 | 1                    // siren / relay
    dout2: 0 | 1                    // fuel cut-off relay
  }
}

export interface CtApiResponse {
  status:  'success' | 'error'
  message: string | null
  data: {
    organisation_code: string
    poll_time_utc:     string
    device_count:      number
    devices:           CtDeviceSnapshot[]
  }
}
