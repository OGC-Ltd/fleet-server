/**
 * The scales, and what each one last did.
 *
 * Feeds the map's weighbridge markers: a pin per physical scale, carrying the
 * last ticket it took so hovering one answers "what happened here" without a
 * trip to the weighbridge page.
 *
 * ## The last ticket AT A BRIDGE, not at a centre
 *
 * A centre can run several scales — Factory runs two and Oyani two — and a
 * ticket names the scale it was taken on (`grossBridgeNo` / `tareBridgeNo`).
 * Grouping by centre would put one centre's newest ticket on both of its pins
 * and quietly claim a scale did work it did not do.
 *
 * ## A ticket is two weighings, and either can be the latest
 *
 * The lorry crosses empty and loaded, and those are separate stamps that can
 * fall on DIFFERENT scales — the yard weighs on whichever is free. So the feed
 * is read as weighings rather than as tickets: each ticket offers up to two,
 * each tagged with the scale that took it, and the newest weighing per scale
 * wins. Reading only `grossAt` would leave a scale that has taken nothing but
 * tares looking idle.
 *
 * `CANE_TRANSFER` tickets carry a second pair taken at the factory on arrival.
 * Those are folded in too, against their own `factory*BridgeNo`, because they
 * are weighings that physically happened on that scale.
 *
 * ## The scales are the ORGANISATION's, not the country's
 *
 * Every scale this build knows about belongs to one mill group, and the layer
 * used to hand all of them to whoever asked — so an organisation with no
 * weighbridges of its own was offered a switch that painted six pins over
 * somebody else's yards, a hundred kilometres from its own fleet. Measured on
 * the box 2026-09-13: every weighment row in the database is Sukari's, and
 * West Kenya's map was drawing all six of them.
 *
 * A scale belongs to the organisation whose tickets it has taken. That is read
 * from the feed rather than written down here, so a centre that starts
 * reporting for another mill appears on that mill's map by itself — and an
 * organisation with none is handed an empty array, which is what removes the
 * switch rather than leaving it to draw somebody else's scales.
 *
 * Scoped by CENTRE rather than by scale, and the centre is the one the BRIDGE
 * belongs to rather than the one on the ticket: a transfer raised at Opapo is
 * weighed again on the factory's own scale, so the ticket's centre is not
 * where that second weighing happened. Widening from the matched scale to its
 * whole yard is deliberate — a yard's second scale being idle for a month is
 * not a reason to draw one of its two pins and hide the other.
 *
 * ## A bridge we cannot place is reported, not guessed
 *
 * `weighbridge.geography` holds the six derived positions. A bridge number in
 * the feed with no entry there is logged once per read and left off the map: a
 * pin at an invented position is a worse answer than a missing pin.
 *
 * ## What this costs
 *
 * A scan of the lookback window rather than six indexed point-lookups, because
 * "the newest weighing per scale" is spread across four nullable bridge columns
 * and none of them is indexed. Measured on the box 2026-09-13: 1,482 rows and
 * 404 kB over 30 days, under the `[organisationId, tokenAt]` index the grid
 * already needs. The feed started 2026-09-07 and runs ~370 tickets a day, so
 * expect this to settle around 11k rows a month.
 *
 * That is cheap for a read the client caches once per organisation, and it is
 * the reason it does. If the window ever wants widening, add the index and a
 * DISTINCT ON before adding the days.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { WEIGHBRIDGES, bridgeOf } from './weighbridge.geography.js'

/** How far back to look for a scale's last ticket. */
const LOOKBACK_DAYS = 30

export interface WeighbridgeLast {
  /** The ticket this weighing belongs to. */
  token:        string
  category:     'CANE_DELIVERY' | 'CANE_TRANSFER'
  /** 'gross' (loaded) or 'tare' (empty) — which crossing this scale took. */
  stage:        'gross' | 'tare'
  /** True when the weighing happened on the factory's own scale at the end of
   *  a transfer, rather than at the outstation that raised the ticket. */
  atFactoryLeg: boolean
  at:           string
  vehicleNo:    string
  vehiclePlate: string
  /** Our vehicle, when the plate resolves to one we track. Null for the
   *  contractors' lorries and farmers' tractors that carry no tracker — which
   *  is most of this traffic, and is why the map's link is conditional. */
  vehicleId:    string | null
  driverName:   string
  operator:     string | null
  /** The ticket's three weights. Gross and tare are the two crossings; net is
   *  the provider's own subtraction, which is the number the farmer is paid
   *  on. Null where the other crossing has not happened yet. */
  grossWeightKg: number | null
  tareWeightKg:  number | null
  netWeightKg:   number | null
  /** What the load was. Null on every delivery row observed so far — the
   *  columns exist upstream and are not being filled — so the map has to render
   *  its absence rather than assume a name. */
  productName:   string | null
}

export interface WeighbridgeDto {
  /** Stable id for the marker: the scale's own number is already unique. */
  id:          string
  centerCode:  number
  centerName:  string
  bridgeNo:    number
  lat:         number
  lng:         number
  /** How tightly the fixes behind this position agreed, in metres, and how
   *  many there were. Shown as a caveat on the loosest markers. */
  spreadM:     number
  samples:     number
  /** The newest weighing this scale took, or null when it has taken none in
   *  the lookback window. */
  last:        WeighbridgeLast | null
}

/** One weighing offered by a ticket: which scale, when, and which crossing. */
interface Weighing {
  bridgeNo: number
  at:       Date
  stage:    'gross' | 'tare'
  atFactoryLeg: boolean
  operator: string | null
}

export async function getWeighbridges(orgId: string): Promise<WeighbridgeDto[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)

  const rows = await prisma.weighment.findMany({
    where:  { organisationId: orgId, tokenAt: { gte: since } },
    select: {
      tokenNumber: true, category: true, tokenAt: true,
      vehicleNo: true, vehiclePlate: true, vehicleId: true, driverName: true,
      grossWeightKg: true, grossAt: true, grossOperator: true, grossBridgeNo: true,
      tareWeightKg: true, tareAt: true, tareOperator: true, tareBridgeNo: true,
      netWeightKg: true, productName: true,
      factoryGrossAt: true, factoryGrossOperator: true, factoryGrossBridgeNo: true,
      factoryTareAt: true, factoryTareOperator: true, factoryTareBridgeNo: true,
    },
    orderBy: { tokenAt: 'desc' },
  })

  /** Newest weighing per scale. */
  const best = new Map<number, { w: Weighing; row: (typeof rows)[number] }>()
  const unplaced = new Set<number>()

  for (const row of rows) {
    const offered: Weighing[] = []
    const add = (bridgeNo: number | null, at: Date | null,
                 stage: 'gross' | 'tare', atFactoryLeg: boolean, operator: string | null) => {
      if (bridgeNo == null || at == null) return
      offered.push({ bridgeNo, at, stage, atFactoryLeg, operator })
    }
    add(row.grossBridgeNo, row.grossAt, 'gross', false, row.grossOperator)
    add(row.tareBridgeNo,  row.tareAt,  'tare',  false, row.tareOperator)
    add(row.factoryGrossBridgeNo, row.factoryGrossAt, 'gross', true, row.factoryGrossOperator)
    add(row.factoryTareBridgeNo,  row.factoryTareAt,  'tare',  true, row.factoryTareOperator)

    for (const w of offered) {
      if (!bridgeOf(w.bridgeNo)) { unplaced.add(w.bridgeNo); continue }
      const held = best.get(w.bridgeNo)
      if (!held || w.at > held.w.at) best.set(w.bridgeNo, { w, row })
    }
  }

  if (unplaced.size > 0) {
    logger.warn(
      { bridgeNos: [...unplaced].sort((a, b) => a - b) },
      'Weighbridge numbers in the ticket feed have no derived position — markers omitted; ' +
      'derive them and add to weighbridge.geography',
    )
  }

  // The yards this organisation actually weighs in — see the note above.
  const centres = new Set<number>()
  for (const bridgeNo of best.keys()) {
    const placed = bridgeOf(bridgeNo)
    if (placed) centres.add(placed.centerCode)
  }

  return WEIGHBRIDGES.filter(b => centres.has(b.centerCode)).map((b): WeighbridgeDto => {
    const hit = best.get(b.bridgeNo)
    return {
      id:         `wb-${b.bridgeNo}`,
      centerCode: b.centerCode,
      centerName: b.centerName,
      bridgeNo:   b.bridgeNo,
      lat:        b.lat,
      lng:        b.lng,
      spreadM:    b.spreadM,
      samples:    b.samples,
      last: hit == null ? null : {
        token:         hit.row.tokenNumber.toString(),
        category:      hit.row.category,
        stage:         hit.w.stage,
        atFactoryLeg:  hit.w.atFactoryLeg,
        at:            hit.w.at.toISOString(),
        vehicleNo:     hit.row.vehicleNo,
        vehiclePlate:  hit.row.vehiclePlate,
        vehicleId:     hit.row.vehicleId,
        driverName:    hit.row.driverName,
        operator:      hit.w.operator,
        grossWeightKg: hit.row.grossWeightKg,
        tareWeightKg:  hit.row.tareWeightKg,
        netWeightKg:   hit.row.netWeightKg,
        productName:   hit.row.productName,
      },
    }
  })
}
