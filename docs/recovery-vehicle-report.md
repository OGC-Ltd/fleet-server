# Daily recovery vehicle report

The recovery report covers the four configured recovery vehicles for one
Nairobi fleet day:

| Registration | Recovery type |
|---|---|
| KDX 130Y | Mechanical |
| KCS 969P | Mechanical |
| KDC 099U | Mechanical |
| KDX 131Y | Puncture |

## Routes

Both routes require `telemetry:read` and the caller's vehicle scope is applied:

| Route | Answer |
|---|---|
| `GET /api/v1/organisations/:orgId/reports/recovery?day=YYYY-MM-DD` | JSON measurements and GPS route points |
| `GET /api/v1/organisations/:orgId/reports/recovery.pdf?day=YYYY-MM-DD` | Printable PDF for the selected day |

The date is in `Africa/Nairobi`; future and invalid calendar days are rejected.
Both routes accept an optional `vehicle` query parameter to report only one
registered recovery vehicle. The accepted values are `KDX 130Y`, `KCS 969P`,
`KDC 099U`, and `KDX 131Y`. The PDF route also accepts `landscape=1` for a
landscape page.
The response includes each configured vehicle, even when it is unavailable in
the organisation or outside the caller's vehicle scope. Unavailable or
unmeasured values are `null`, not zero.

## Measurements

- **Distance** uses the trip report's measured moving GPS segments.
- **Route** is the day's recorded GPS trace, as `[latitude, longitude]` points.
  The PDF plots that trace without a basemap.
- **Fuel consumed** uses the existing day-report fuel counter/probe calculation.
  It is `null` when the day's readings cannot support a measurement.
- **Stops** are GPS stands of at least five minutes. `stopsTotal` counts all
  such stops; the listed stop details contain the eight longest at most.

Vehicles without GPS telemetry have no distance, fuel, or stop totals reported.
