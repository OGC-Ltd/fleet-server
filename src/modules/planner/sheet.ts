/**
 * Reading a delivery sheet (Planner, operator 2026-11-11): Menengai's "Sales
 * Order Booking Delivery Sheet", one truck and one day, as the sales system
 * prints it to .xlsx.
 *
 *   NO.                                        ← title rows, merged across
 *   Sales Order Booking Delivery Sheet
 *   TILL NO:
 *   Truck Number: KDE 128E          Gate Pass:
 *   Date: 2026-11-09 09:36:16       Driver Name: JOHN DOE
 *   NO. | REP | CUSTOMER ID | CUSTOMER NAME | LOCATION | COORDINATES | INVOICE NO. | AMOUNT | TONNAGE | FULL | PARTLY | REJECTED | REMARKS
 *   1   | …   | 100001      | SAMPLE SHOP   | TOWN     | LAT: -0.1000 LONG: 36.1000 | 0 | 3957 | 0.02 | | | | --
 *   …
 *   TOTALS                                       2.05
 *   Driver Name | JOHN DOE …               ← sign-off footer, ignored
 *
 * Header fields are found by their label anywhere above the column headings,
 * and columns by their heading text, so a sheet with a column added or moved
 * still reads. Pure: no database, no clock.
 */
import * as XLSX from 'xlsx'

export type Outcome = 'FULL' | 'PARTLY' | 'REJECTED'

export interface SheetHeader {
  plate: string
  /** The day the sheet is for, YYYY-MM-DD (from its Date: line). */
  planDate: string | null
  /** When it was printed, ISO, read as Nairobi time (+03:00). */
  sheetAt: string | null
  driverName: string
  gatePass: string
  tillNo: string
}

export interface SheetStop {
  sequence: number
  rep: string
  customerCode: string
  customerName: string
  location: string
  lat: number | null
  lng: number | null
  invoiceNo: string
  amount: number | null
  tonnage: number | null
  /** Already ticked on the sheet, which is rare at upload. */
  outcome: Outcome | null
  remarks: string
  /** The spreadsheet row, 1-based, for messages. */
  row: number
}

export interface SheetProblem { row: number | null, message: string }

export interface DeliverySheet {
  header: SheetHeader
  stops: SheetStop[]
  problems: SheetProblem[]
}

const text = (v: unknown) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim()
const key = (v: unknown) => text(v).toUpperCase().replace(/[^A-Z0-9]/g, '')

/** "3,957" / "KES 3 957.50" / 3957 → 3957; blank or unreadable → null. */
export function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = text(v).replace(/[^0-9.\-]/g, '')
  if (!s || s === '-' || s === '.') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * A point from a cell: "LAT: -0.0951 LONG: 36.1270", "-0.0951, 36.1270",
 * "-0.0951 36.1270". Latitude first unless labelled otherwise.
 */
export function readCoordinates(v: unknown): { lat: number, lng: number } | null {
  const s = text(v)
  if (!s) return null
  const lat = /LAT(?:ITUDE)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(s)
  const lng = /(?:LONG|LNG|LON)(?:ITUDE)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(s)
  if (lat && lng) return { lat: Number(lat[1]), lng: Number(lng[1]) }
  const nums = s.match(/-?\d+(?:\.\d+)?/g)
  if (nums && nums.length === 2) return { lat: Number(nums[0]), lng: Number(nums[1]) }
  return null
}

/** Where a point can be for these fleets: East Africa, with room. */
const plausible = (p: { lat: number, lng: number }) => p.lat >= -12 && p.lat <= 6 && p.lng >= 28 && p.lng <= 42

/** Each column's heading, as `key()` writes it, to the field it fills. */
const COLUMNS: Record<string, keyof ColumnMap> = {
  NO: 'no', REP: 'rep', SALESREP: 'rep',
  CUSTOMERID: 'customerCode', CUSTOMERNO: 'customerCode', CUSTOMERCODE: 'customerCode', CUSTID: 'customerCode',
  CUSTOMERNAME: 'customerName', CUSTOMER: 'customerName',
  LOCATION: 'location', ROUTE: 'location', AREA: 'location',
  COORDINATES: 'coords', COORDINATE: 'coords', GPS: 'coords', LATLONG: 'coords',
  LAT: 'lat', LATITUDE: 'lat', LONG: 'lng', LNG: 'lng', LONGITUDE: 'lng',
  INVOICENO: 'invoiceNo', INVOICE: 'invoiceNo', INVOICENUMBER: 'invoiceNo',
  AMOUNT: 'amount', VALUE: 'amount', TONNAGE: 'tonnage', TONNES: 'tonnage', TONS: 'tonnage',
  FULL: 'full', PARTLY: 'partly', PARTIAL: 'partly', REJECTED: 'rejected', REMARKS: 'remarks', REMARK: 'remarks',
}
interface ColumnMap {
  no?: number; rep?: number; customerCode?: number; customerName?: number; location?: number
  coords?: number; lat?: number; lng?: number; invoiceNo?: number; amount?: number; tonnage?: number
  full?: number; partly?: number; rejected?: number; remarks?: number
}

/** Header labels, as `key()` writes them before the colon. */
const LABELS: Record<string, keyof SheetHeader | 'date'> = {
  TRUCKNUMBER: 'plate', TRUCKNO: 'plate', TRUCK: 'plate', VEHICLE: 'plate', VEHICLENO: 'plate', REGNO: 'plate',
  DATE: 'date', DRIVERNAME: 'driverName', DRIVER: 'driverName', GATEPASS: 'gatePass', TILLNO: 'tillNo',
}

/** "2026-11-09 09:36:16", "09/11/2026", or an Excel date → day and instant. */
function readDate(v: unknown): { day: string, at: string | null } | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const day = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    return { day, at: null }
  }
  const s = text(v)
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s)
  let y: string, mo: string, d: string
  if (m) { [, y, mo, d] = m }
  else {
    m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s)
    if (!m) return null
    ;[, d, mo, y] = m
  }
  const p2 = (x: string) => x.padStart(2, '0')
  const day = `${y}-${p2(mo)}-${p2(d)}`
  const at = m[4] != null ? `${day}T${p2(m[4])}:${m[5]}:${m[6] ?? '00'}+03:00` : null
  return { day, at }
}

const ticked = (v: unknown) => {
  const s = key(v)
  return s !== '' && s !== '0' && s !== 'NO' && s !== 'N'
}

/** Read a delivery sheet's first worksheet that has a CUSTOMER ID heading. */
export function readDeliverySheet(file: Buffer | ArrayBuffer): DeliverySheet {
  const wb = XLSX.read(file, { type: 'buffer', cellDates: true })
  const problems: SheetProblem[] = []
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: true })
    const headingAt = rows.findIndex((r) => (r ?? []).some((c) => COLUMNS[key(c)] === 'customerCode'))
    if (headingAt < 0) continue
    return readRows(rows, headingAt, problems)
  }
  problems.push({ row: null, message: 'No CUSTOMER ID column heading was found in any sheet of the workbook.' })
  return { header: { plate: '', planDate: null, sheetAt: null, driverName: '', gatePass: '', tillNo: '' }, stops: [], problems }
}

function readRows(rows: unknown[][], headingAt: number, problems: SheetProblem[]): DeliverySheet {
  // Header: every "Label: value" cell above the headings; a value left empty
  // after the colon is the next filled cell on that row.
  const header: SheetHeader = { plate: '', planDate: null, sheetAt: null, driverName: '', gatePass: '', tillNo: '' }
  for (let r = 0; r < headingAt; r++) {
    const row = rows[r] ?? []
    row.forEach((cell, c) => {
      const s = text(cell)
      const m = /^([^:]{2,30}):\s*(.*)$/.exec(s)
      if (!m) return
      const field = LABELS[key(m[1])]
      if (!field) return
      let value: unknown = m[2]
      if (!text(value)) {
        const next = row.slice(c + 1).find((x) => text(x) !== '' && !/:\s*$/.test(text(x)))
        value = next ?? ''
      }
      if (field === 'date') {
        const d = readDate(value)
        if (d) { header.planDate = d.day; header.sheetAt = d.at }
      } else if (!header[field]) {
        (header as unknown as Record<string, string>)[field] = text(value)
      }
    })
  }

  const cols: ColumnMap = {}
  ;(rows[headingAt] ?? []).forEach((cell, c) => {
    const f = COLUMNS[key(cell)]
    if (f && cols[f] == null) cols[f] = c
  })
  const at = (row: unknown[], f: keyof ColumnMap) => (cols[f] == null ? null : row[cols[f]!])

  const stops: SheetStop[] = []
  for (let r = headingAt + 1; r < rows.length; r++) {
    const row = rows[r] ?? []
    if (/^TOTALS?$/i.test(text(row[0])) || row.some((c) => /^TOTALS?$/i.test(text(c)))) break
    const code = text(at(row, 'customerCode'))
    const name = text(at(row, 'customerName'))
    if (!code && !name) continue
    const line = r + 1
    if (!code) { problems.push({ row: line, message: `${name}: no CUSTOMER ID, so the line was left out.` }); continue }

    let point = cols.coords != null ? readCoordinates(at(row, 'coords')) : null
    if (!point && cols.lat != null && cols.lng != null) {
      const la = readNumber(at(row, 'lat')); const ln = readNumber(at(row, 'lng'))
      if (la != null && ln != null) point = { lat: la, lng: ln }
    }
    if (point && !plausible(point) && plausible({ lat: point.lng, lng: point.lat })) {
      point = { lat: point.lng, lng: point.lat }
      problems.push({ row: line, message: `${name}: latitude and longitude were the wrong way round and were swapped.` })
    }
    if (!point || (point.lat === 0 && point.lng === 0)) {
      problems.push({ row: line, message: `${name} (${code}): no coordinates.` })
      point = null
    } else if (!plausible(point)) {
      problems.push({ row: line, message: `${name} (${code}): ${point.lat}, ${point.lng} is outside East Africa.` })
      point = null
    }

    const marks: Outcome[] = []
    if (ticked(at(row, 'full'))) marks.push('FULL')
    if (ticked(at(row, 'partly'))) marks.push('PARTLY')
    if (ticked(at(row, 'rejected'))) marks.push('REJECTED')
    const remarks = text(at(row, 'remarks'))
    stops.push({
      sequence: stops.length + 1,
      rep: text(at(row, 'rep')),
      customerCode: code,
      customerName: name || code,
      location: text(at(row, 'location')),
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      invoiceNo: text(at(row, 'invoiceNo')),
      amount: readNumber(at(row, 'amount')),
      tonnage: readNumber(at(row, 'tonnage')),
      outcome: marks.length === 1 ? marks[0] : null,
      remarks: /^-+$/.test(remarks) ? '' : remarks,
      row: line,
    })
  }
  if (!stops.length) problems.push({ row: null, message: 'The sheet lists no customers.' })
  if (!header.plate) problems.push({ row: null, message: 'No Truck Number on the sheet.' })
  if (!header.planDate) problems.push({ row: null, message: 'No Date on the sheet.' })
  return { header, stops, problems }
}
