/**
 * The review as an Excel workbook — every row behind it, laid out for a Power BI
 * analyst: one sheet per table, a header row, typed cells, keys between sheets.
 *
 * Same nine sheets as the hand-built August–September reviews: README, Summary,
 * Daily, Places, Stops, Trips, Hourly, Calendar, GPS_Points.
 *
 * Times are written as Excel serial numbers in Kenyan time (EAT) directly,
 * rather than as JS Dates, which SheetJS would convert through the SERVER's own
 * time zone.
 */

import * as XLSX from 'xlsx'
import { rezip } from './rezip.js'
import { daysBetween, fuelOf, TZ_OFFSET_MS } from './usage-review.compute.js'
import type { ReadyReview } from './usage-review.service.js'

type V = string | number | boolean | null | undefined
interface Col<T> { h: string; v: (row: T) => V; fmt?: 'date' | 'time'; w?: number }

/** Whole seconds: a fix's milliseconds are noise, and would print as "00:02:45.024". */
const serial = (ms: number) => (Math.round(ms / 1000) * 1000 + TZ_OFFSET_MS) / 86_400_000 + 25_569
const daySerial = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000 + 25_569
const FMT = { date: 'yyyy-mm-dd', time: 'yyyy-mm-dd hh:mm' }

function sheet<T>(rows: T[], cols: Col<T>[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {}
  cols.forEach((c, j) => { ws[XLSX.utils.encode_cell({ r: 0, c: j })] = { t: 's', v: c.h } })
  rows.forEach((row, i) => {
    cols.forEach((c, j) => {
      const v = c.v(row)
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return
      const cell: XLSX.CellObject = typeof v === 'number' ? { t: 'n', v } : typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v }
      if (c.fmt && typeof v === 'number') cell.z = FMT[c.fmt]
      ws[XLSX.utils.encode_cell({ r: i + 1, c: j })] = cell
    })
  })
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: cols.length - 1 } })
  ws['!cols'] = cols.map(c => ({ wch: c.w ?? Math.max(10, c.h.length + 2) }))
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: cols.length - 1 } }) }
  return ws
}

const t = (ms: number | null) => (ms == null ? null : serial(ms))
const yn = (b: boolean) => (b ? 'Yes' : 'No')
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export function buildUsageReviewXlsx(rv: ReadyReview, kmpl: number | null, kmplNote: string): Buffer {
  const s = rv.summary, q = rv.quality, veh = rv.vehicle
  const place = new Map(rv.places.map(p => [p.id, p]))
  // Google's name where the page found one, the OpenStreetMap area otherwise.
  const pname = (id: number) => { const pl = place.get(id); return pl?.exactName ?? pl?.name ?? `Place ${id}` }
  const fuelBasis = kmpl ? `Distance ÷ ${kmpl} km/L (${kmplNote})` : 'No km/L rate set, so no fuel estimate'
  const top = rv.places[0]

  const readme: [string, string][] = [
    ['Vehicle', `${veh.plate}${veh.name && veh.name !== veh.plate ? ` (${veh.name})` : ''} · ${veh.organisation} · Wialon unit "${veh.wialonName ?? veh.wialonUnitId}" (id ${veh.wialonUnitId})`],
    ['Period', `${longDate(rv.period.from)} – ${longDate(rv.period.to)} (${rv.period.days} days)`],
    ['Source', `Wialon message history, ${q.messages.toLocaleString('en-GB')} messages; built ${new Date(rv.builtAt + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} EAT`],
    ['Time zone', 'All dates and times are Kenyan time (EAT, UTC+3). A day runs 00:00–24:00 EAT.'],
    ['Data', `${q.daysFromDb} day(s) read from the FleetTrack database, ${q.daysFromWialon} from Wialon's history (days the database did not hold completely). Daily[Source] says which.`
      + (rv.incompleteDays.length ? ` Wialon could not be reached (${rv.wialonError}); ${rv.incompleteDays.length} day(s) may be incomplete: ${rv.incompleteDays.join(', ')}.` : '')],
    ['Distance', q.distanceSource === 'odometer'
      ? 'Tracker odometer, carried forward over messages that omit it.'
      : q.distanceSource === 'mixed'
        ? 'Tracker odometer on Wialon days; GPS track on database days (the database stores no odometer). GPS jumps faster than 160 km/h are not counted.'
        : 'GPS track (no odometer available). Jumps faster than 160 km/h are not counted.'],
    ['Drive time', 'Time moving at ≥ 5 km/h. Gaps between messages capped at 5 minutes.'],
    ['Engine time', q.ignition ? 'Ignition on. Idle = engine time − drive time.' : 'Not available: this tracker reports no ignition.'],
    ['Fuel', kmpl ? `ESTIMATE: ${fuelBasis}. Recompute in Power BI as DistanceKm / your rate.` : fuelBasis],
    ['Stops', 'Stationary (< 3 km/h) for 10 minutes or more. Position = median of the stop\'s fixes.'],
    ['Places', 'Stops grouped within 400 m. Names from OpenStreetMap. Place 1 is where it spent the most time.'],
    ['Trips', 'Driving between two consecutive stops, kept when ≥ 0.5 km.'],
    ['Relationships (Power BI)', 'Calendar[Date] 1→* Daily[Date], Stops[Date], Trips[Date], Hourly[Date], GPS_Points[Date]; Places[PlaceID] 1→* Stops[PlaceID], Trips[FromPlaceID] (active), Trips[ToPlaceID] (inactive); Stops[StopID] 1→* Trips[FromStopID].'],
    ['Map visuals', 'Use the Latitude/Longitude columns in Places, Stops or GPS_Points. Size place bubbles by TotalHours.'],
  ]
  const wsReadme = XLSX.utils.aoa_to_sheet([['Item', 'Detail'], ...readme])
  wsReadme['!cols'] = [{ wch: 26 }, { wch: 120 }]

  const totFuel = fuelOf(s.km, kmpl)
  const summary: [string, V, string, string][] = [
    ['Period', `${longDate(rv.period.from)} – ${longDate(rv.period.to)}`, '', 'EAT days'],
    ['Calendar days', s.calendarDays, 'days', ''],
    ['Days with movement (≥1 km)', s.activeDays, 'days', ''],
    ['1. Average drive hours per day', s.driveHPerDay, 'h/day', `Over all ${s.calendarDays} calendar days`],
    ['1b. Average drive hours per active day', s.driveHPerActiveDay, 'h/day', `Over the ${s.activeDays} days it moved`],
    ['Total drive hours', s.driveH, 'h', 'Speed ≥ 5 km/h'],
    ['Total engine hours', s.engineH, 'h', 'Ignition on'],
    ['Total idle hours', s.idleH, 'h', 'Engine on, not driving'],
    ['2. Total distance', s.km, 'km', q.distanceSource === 'odometer' ? 'Tracker odometer' : q.distanceSource === 'mixed' ? 'Odometer (Wialon days) + GPS (database days)' : 'GPS track'],
    ['3. Average distance per day', s.kmPerDay, 'km/day', `Over all ${s.calendarDays} calendar days`],
    ['3b. Average distance per active day', s.kmPerActiveDay, 'km/day', `Over the ${s.activeDays} days it moved`],
    ['4. Average fuel per day (estimate)', totFuel != null ? Math.round((totFuel / s.calendarDays) * 10) / 10 : null, 'L/day', fuelBasis],
    ['4b. Average fuel per active day (estimate)', totFuel != null && s.activeDays ? Math.round((totFuel / s.activeDays) * 10) / 10 : null, 'L/day', fuelBasis],
    ['Total fuel (estimate)', totFuel, 'L', fuelBasis],
    ['5. Place with most time', top?.exactName ?? top?.name ?? '', '', top ? `${top.lat.toFixed(6)}, ${top.lng.toFixed(6)}${top.address ? ` · ${top.address}` : ''}` : ''],
    ['5. Hours at that place', top?.hours ?? null, 'h', top ? `${top.visits} stops on ${top.days} days` : ''],
    ['Total stopped time (stops ≥10 min)', s.stoppedH, 'h', `${s.stops} stops at ${s.places} places`],
    ['Trips', s.trips, '', ''],
    ['Average moving speed', s.avgMovingKmh, 'km/h', 'Distance ÷ drive hours'],
    ['Top speed', s.maxKmh, 'km/h', ''],
    ['Longest day', s.longestDay ? `${s.longestDay.date} · ${s.longestDay.km} km` : '', '', ''],
    ['GPS vs odometer', q.gpsVsOdometerPct, '%', q.worstDay ? `Worst day ${q.worstDay.date}: ${q.worstDay.pct}%` : ''],
  ]
  const wsSummary = sheet(summary, [
    { h: 'Metric', v: r => r[0], w: 42 }, { h: 'Value', v: r => r[1], w: 30 }, { h: 'Unit', v: r => r[2] }, { h: 'Basis', v: r => r[3], w: 70 },
  ])

  const wsDaily = sheet(rv.days, [
    { h: 'Date', v: d => daySerial(d.date), fmt: 'date', w: 12 },
    { h: 'Month', v: d => d.date.slice(0, 7) },
    { h: 'Weekday', v: d => new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) },
    { h: 'Moved', v: d => yn(d.moved) },
    { h: 'DistanceKm', v: d => d.km }, { h: 'DriveHours', v: d => d.driveH }, { h: 'EngineHours', v: d => d.engineH },
    { h: 'IdleHours', v: d => d.idleH }, { h: 'AvgMovingSpeedKmh', v: d => d.avgKmh }, { h: 'MaxSpeedKmh', v: d => d.maxKmh },
    { h: 'EstFuelL', v: d => fuelOf(d.km, kmpl) }, { h: 'Trips', v: d => d.trips }, { h: 'Stops10min', v: d => d.stops },
    { h: 'FirstMove', v: d => t(d.firstMove), fmt: 'time', w: 17 }, { h: 'LastMove', v: d => t(d.lastMove), fmt: 'time', w: 17 },
    { h: 'OdometerStartKm', v: d => d.odoStartKm }, { h: 'OdometerEndKm', v: d => d.odoEndKm }, { h: 'Messages', v: d => d.messages },
    { h: 'Source', v: d => (d.source === 'db' ? 'Database' : d.source === 'wialon' ? 'Wialon' : d.source === 'mixed' ? 'Mixed' : null) },
  ])

  const wsPlaces = sheet(rv.places, [
    { h: 'PlaceID', v: p => p.id }, { h: 'Rank', v: p => p.id }, { h: 'PlaceName', v: p => p.exactName ?? p.name ?? `Place ${p.id}`, w: 40 }, { h: 'Area_OpenStreetMap', v: p => p.name ?? null, w: 36 }, { h: 'Kind', v: p => (p.kind === 'work' ? (p.site ? `Work site: ${p.site}` : 'Work site') : p.kind === 'home' ? 'Home area' : p.kind ? 'Outside work sites' : null), w: 26 }, { h: 'Nights', v: p => p.nights ?? null },
    { h: 'Area', v: p => p.area, w: 30 }, { h: 'County_or_Region', v: p => p.county, w: 20 }, { h: 'Country', v: p => p.country },
    { h: 'Latitude', v: p => Math.round(p.lat * 1e6) / 1e6 }, { h: 'Longitude', v: p => Math.round(p.lng * 1e6) / 1e6 },
    { h: 'TotalHours', v: p => p.hours }, { h: 'Visits', v: p => p.visits }, { h: 'DaysPresent', v: p => p.days },
    { h: 'ShareOfStoppedTimePct', v: p => p.share },
    { h: 'FirstSeen', v: p => t(p.firstSeen), fmt: 'time', w: 17 }, { h: 'LastSeen', v: p => t(p.lastSeen), fmt: 'time', w: 17 },
    { h: 'OSM_Address', v: p => p.address, w: 60 },
  ])

  const wsStops = sheet(rv.stops, [
    { h: 'StopID', v: x => x.id }, { h: 'Date', v: x => t(x.start) != null ? Math.floor(serial(x.start)) : null, fmt: 'date', w: 12 },
    { h: 'StartTime', v: x => t(x.start), fmt: 'time', w: 17 }, { h: 'EndTime', v: x => t(x.end), fmt: 'time', w: 17 },
    { h: 'DurationMin', v: x => x.min }, { h: 'Latitude', v: x => Math.round(x.lat * 1e6) / 1e6 }, { h: 'Longitude', v: x => Math.round(x.lng * 1e6) / 1e6 },
    { h: 'PlaceID', v: x => x.place }, { h: 'Overnight', v: x => yn(x.overnight) }, { h: 'PlaceName', v: x => pname(x.place), w: 36 },
  ])

  const wsTrips = sheet(rv.trips, [
    { h: 'TripID', v: x => x.id }, { h: 'Date', v: x => Math.floor(serial(x.start)), fmt: 'date', w: 12 },
    { h: 'StartTime', v: x => t(x.start), fmt: 'time', w: 17 }, { h: 'EndTime', v: x => t(x.end), fmt: 'time', w: 17 },
    { h: 'DurationMin', v: x => x.min }, { h: 'DriveMin', v: x => x.driveMin }, { h: 'DistanceKm', v: x => x.km },
    { h: 'MaxSpeedKmh', v: x => x.maxKmh }, { h: 'AvgMovingSpeedKmh', v: x => x.avgKmh },
    { h: 'FromStopID', v: x => x.fromStop }, { h: 'ToStopID', v: x => x.toStop },
    { h: 'FromPlaceID', v: x => x.fromPlace }, { h: 'ToPlaceID', v: x => x.toPlace },
    { h: 'StartLat', v: x => Math.round(x.from[0] * 1e6) / 1e6 }, { h: 'StartLng', v: x => Math.round(x.from[1] * 1e6) / 1e6 },
    { h: 'EndLat', v: x => Math.round(x.to[0] * 1e6) / 1e6 }, { h: 'EndLng', v: x => Math.round(x.to[1] * 1e6) / 1e6 },
    { h: 'EstFuelL', v: x => fuelOf(x.km, kmpl) },
    { h: 'FromPlace', v: x => pname(x.fromPlace), w: 30 }, { h: 'ToPlace', v: x => pname(x.toPlace), w: 30 },
  ])

  const wsHourly = sheet(rv.hours, [
    { h: 'Date', v: x => daySerial(x.date), fmt: 'date', w: 12 }, { h: 'Hour', v: x => x.hour },
    { h: 'DriveMin', v: x => x.driveMin }, { h: 'EngineMin', v: x => x.engineMin }, { h: 'DistanceKm', v: x => x.km },
  ])

  const cal = daysBetween(rv.period.from, rv.period.to).map(d => {
    const dt = new Date(`${d}T00:00:00Z`)
    const wd = (dt.getUTCDay() + 6) % 7 + 1
    const th = new Date(dt); th.setUTCDate(dt.getUTCDate() + 4 - wd)
    const isoWeek = Math.ceil(((th.getTime() - Date.UTC(th.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
    return { d, dt, wd, isoWeek }
  })
  const wsCal = sheet(cal, [
    { h: 'Date', v: c => daySerial(c.d), fmt: 'date', w: 12 }, { h: 'Year', v: c => c.dt.getUTCFullYear() },
    { h: 'MonthNo', v: c => c.dt.getUTCMonth() + 1 },
    { h: 'Month', v: c => c.dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) },
    { h: 'Day', v: c => c.dt.getUTCDate() },
    { h: 'Weekday', v: c => c.dt.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) },
    { h: 'WeekdayNo', v: c => c.wd }, { h: 'ISOWeek', v: c => c.isoWeek }, { h: 'Weekend', v: c => yn(c.wd >= 6) },
  ])

  const wsGps = sheet(rv.points, [
    { h: 'Timestamp', v: p => serial(p.t), fmt: 'time', w: 17 }, { h: 'Date', v: p => Math.floor(serial(p.t)), fmt: 'date', w: 12 },
    { h: 'Latitude', v: p => Math.round(p.lat * 1e6) / 1e6 }, { h: 'Longitude', v: p => Math.round(p.lng * 1e6) / 1e6 },
    { h: 'SpeedKmh', v: p => p.speed }, { h: 'HeadingDeg', v: p => p.course },
    { h: 'Ignition', v: p => (p.ign == null ? null : p.ign ? 'On' : 'Off') }, { h: 'OdometerKm', v: p => p.odoKm },
    { h: 'Moving', v: p => yn(p.moving) },
  ])

  const wb = XLSX.utils.book_new()
  const add = (name: string, ws: XLSX.WorkSheet) => XLSX.utils.book_append_sheet(wb, ws, name)
  add('README', wsReadme); add('Summary', wsSummary); add('Daily', wsDaily); add('Places', wsPlaces); add('Stops', wsStops)
  add('Trips', wsTrips); add('Hourly', wsHourly); add('Calendar', wsCal); add('GPS_Points', wsGps)
  for (const name of wb.SheetNames.slice(1)) wb.Sheets[name]!['!freeze'] = { xSplit: 0, ySplit: 1 }
  // Written stored, deflated by zlib: see rezip.
  return rezip(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: false, bookSST: true }) as Buffer)
}
