import type { Request, Response, NextFunction } from 'express'
import { logger } from '../../lib/logger.js'
import { sendSuccess } from '../../core/response/response.js'
import { ingestAlerts, type RaiFactorySuiteAlert } from './raifactorysuite-alerts.service.js'
import { handleDispatch, handleMovement, handleSale } from './raifactorysuite-events.service.js'
import { handleWeighment } from '../weighments/weighment.ingest.js'
import { ingestWialonNotifications } from './wialon-notifications.service.js'
import { workPlansChanged } from '../planner/work-plans.service.js'
import { isWorkPlanEvent, requestWorkPlanWatch } from '../planner/work-plan-watch.js'
import { isWorkshopEvent, requestWorkshopSync } from '../repairs/factorysuite-workshop.runner.js'
import { webhookSourceOf } from '../../middleware/webhookAuth.js'
import { deliveryKey, firstDelivery, newShape } from './delivery-repeats.js'
import { isMachineRegisterEvent, isUnusedEvent } from './hook-events.js'
import { requestMachineRegisterSync } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import {
  raiFactorySuiteAlertSchema,
  raiFactorySuiteDispatchSchema,
  raiFactorySuiteMovementSchema,
  raiFactorySuiteSaleSchema,
  raiFactorySuiteWeighmentSchema,
  wialonNotificationSchema,
  looksLikeSale,
  looksLikeWeighment,
  providerDispatchType,
  unwrapEvent,
} from './webhooks.schema.js'

/**
 * POST /webhook/rai
 *
 * RaiFactorySuite posts these event types here:
 *   alert.created      → operational alert (persisted + Live Feed)
 *   dispatch.created   → driver↔vehicle assignment (persisted + Live Feed)
 *   dispatch.updated   → the same run, changed
 *   movement.created   → gate crossing (Live Feed only; carries no coordinates)
 *   weighment.created  → weighbridge ticket (persisted; NOT narrated — see below)
 *   weighment.updated  → the same ticket, re-weighed or corrected
 *   fuelplan.* / fuel.request.* / fuel.issue.*
 *                      → a work plan, fuel request or pump fuelling changed:
 *                        the plans are re-read and open pages refresh; nothing
 *                        is stored from the payload
 *   jobcard.* / breakdown.* / requisition.* / part.* / purchaseorder.*
 *                      → the Auto Workshop changed: the workshop feeds are
 *                        re-read and fed into the repair workflow at once
 *                        (repairs/factorysuite-workshop.runner)
 *   machine.created / machine.updated
 *                      → the machine register is re-read on the next cycle
 *   every other event on FactorySuite's list (field, gate, visitor, driver,
 *   vehicle request, register) → acknowledged, not used (hook-events)
 *
 * From 19 Nov 2026 the WORK_PLANNER_HOOK webhook is the default and carries
 * all of these; the original webhook (FACTORY_SUITE_HOOK) is still accepted.
 *
 * A 4xx makes their sender retry a few times and then DROP the event, so an
 * unrecognised shape must never fail the request: acknowledge it, log the
 * shape so it can be wired up, and move on. Persistence is idempotent on the
 * provider's own ids, so a retry is harmless.
 *
 * FactorySuite gives 5 s to answer and says to reply straight away and do the
 * work afterwards, and to ignore a repeat. So any event seen moments ago with
 * the same name and data (both webhooks may carry it) is acknowledged and
 * dropped (delivery-repeats), and telling open pages a plan changed waits for
 * the reply. The log line names the webhook a delivery came from (`source`).
 */
export async function providerWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { event, items } = unwrapEvent(req.body)
    const kind = (event ?? '').toLowerCase()

    const alerts: RaiFactorySuiteAlert[] = []
    const unmapped: unknown[] = []
    let dispatches = 0
    let movements  = 0
    let sales      = 0
    let weighments = 0
    let workPlans  = 0
    let workPlanOrgs = 0
    let workshop   = 0
    let register   = 0
    let unused     = 0
    let repeats    = 0
    // Work that only refreshes (telling open pages a plan changed). FactorySuite
    // asks for a 2xx straight away and the work afterwards, so it runs once the
    // reply has gone.
    const afterReply: Array<() => Promise<void>> = []

    const wialonNotifications: Parameters<typeof ingestWialonNotifications>[0] = []

    for (const item of items) {
      // Wialon's "Send a request" action posts a `notification` field. It has
      // no event envelope of its own, so the field itself is the marker.
      const wn = wialonNotificationSchema.safeParse(item)
      if (wn.success && (kind.startsWith('wialon') || !kind)) {
        wialonNotifications.push(wn.data)
        continue
      }

      // A repeat: the same event name and data as one handled moments ago
      // (delivery-repeats). Stored events were idempotent already; this also
      // spares their writes while both webhooks carry the same events.
      if (kind && !firstDelivery(deliveryKey(kind, item))) { repeats++; continue }

      // Work plan events (fuelplan.*), and the fuel request and pump issue
      // events that follow a plan line (fuel.request.*, fuel.issue.*). Nothing
      // is stored from the payload: the plans are re-read from FactorySuite
      // (planner/work-plan-watch, in a moment) and the cached map and Fuel
      // page reads are dropped, with the org's open pages told to read again.
      // By NAME, first, so no plan payload is ever tried against a dispatch
      // or alert shape.
      if (isWorkPlanEvent(kind)) {
        const keys = newShape(kind, item)
        if (keys) logger.info({ event: kind, keys }, 'Work plan event: first of its kind since start')
        afterReply.push(async () => { workPlanOrgs += await workPlansChanged(kind, item) })
        requestWorkPlanWatch(kind)
        workPlans++
        continue
      }

      // Workshop events: the payload is not trusted for state. It only says
      // that something changed, and the feeds are re-read in a moment; the
      // same pass the reconcile loop runs every cycle.
      if (isWorkshopEvent(kind)) {
        requestWorkshopSync(kind)
        workshop++
        continue
      }

      // The machine register changed: the next reconcile cycle re-reads it.
      if (isMachineRegisterEvent(kind)) {
        requestMachineRegisterSync()
        register++
        continue
      }

      // Every other event on FactorySuite's list: acknowledged, not used, and
      // never tried against a dispatch, sale or weighment shape (hook-events).
      // Field names only in the log: these payloads name people.
      if (isUnusedEvent(kind)) {
        const keys = newShape(kind, item)
        if (keys) logger.info({ event: kind, keys }, 'FactorySuite event acknowledged, not used: first of its kind since start')
        unused++
        continue
      }

      // The provider's own word first, where it gives one (FactorySuite
      // v1.4.32 stamps every dispatch with `type`). Decisive in a way the
      // shape never was — and the only thing that keeps a MATERIAL dispatch,
      // which has a plate and a driver like a cane one, out of the cane table.
      // Material runs are not modelled yet: logged as unmapped, with their
      // shape, so they can be wired up from real payloads.
      const declared = providerDispatchType(item)
      if (declared === 'SALES') {
        const sl = raiFactorySuiteSaleSchema.safeParse(item)
        if (sl.success) { if (await handleSale(sl.data)) sales++; continue }
      } else if (declared === 'VEHICLE') {
        const d = raiFactorySuiteDispatchSchema.safeParse(item)
        if (d.success) { if (await handleDispatch(d.data)) dispatches++; continue }
      } else if (declared === 'MATERIAL') {
        unmapped.push(item)
        continue
      }

      // No declared type (older deliveries, replays): SALES FIRST, and by
      // SHAPE rather than by name.
      //
      // The provider reuses `dispatch.created` and `movement.created` for the
      // sales lifecycle — it does not mint an event name of its own — so the
      // declared name cannot tell the two apart. Leaving the dispatch branch
      // first was actively wrong: a sales payload parses CLEANLY against the
      // dispatch schema (it carries id/factoryCode/plate/driverName, and
      // `dispatchTime` is merely optional), so it would have been stored as a
      // cane dispatch with the tonnage dropped and a dispatch time invented
      // from the receive clock.
      //
      // The shape is decisive in the other direction too, which is what makes
      // this safe to put first: `tonnage`, `signOutTime` and `returnTime`
      // appear on no other payload the provider sends. A real cane dispatch
      // carries `dispatchTime`/`actualReturnTime` and none of these three, and
      // a movement carries none of them either — so neither can be captured
      // here by mistake.
      if (looksLikeSale(item)) {
        const sl = raiFactorySuiteSaleSchema.safeParse(item)
        if (sl.success) { if (await handleSale(sl.data)) sales++; continue }
      }

      // WEIGHMENTS, before the dispatch branch and for a weaker version of
      // the same reason sales go first: a ticket carries `vehicleNo` and
      // `driverName`, and while it fails the dispatch schema today (no `id`,
      // no `factoryCode`) that is a coincidence of shape rather than a
      // guarantee. Routing on the provider's own `category` is decisive, so
      // put it where nothing else can claim it first.
      //
      // Unlike a dispatch, a ticket is NOT narrated into the Live Feed. Nearly
      // 800 tickets crossed these four bridges on the day this was written; a
      // feed line each would bury every other event on the board, and a
      // weighing is something you go and look at rather than something that
      // has to interrupt you. It is persisted and the weighbridge page reads
      // it — see modules/weighments.
      if (kind.startsWith('weighment') || looksLikeWeighment(item)) {
        const w = raiFactorySuiteWeighmentSchema.safeParse(item)
        if (w.success) {
          // The zod object is passthrough, so the un-modelled leg fields are
          // still on it — the ingest reads them off the original shape.
          if (await handleWeighment(item as Parameters<typeof handleWeighment>[0], { source: 'webhook' })) weighments++
          continue
        }
      }

      // Prefer the declared event name; fall back to shape-sniffing so a
      // renamed event still lands somewhere sensible.
      if (kind.startsWith('dispatch')) {
        const d = raiFactorySuiteDispatchSchema.safeParse(item)
        if (d.success) { if (await handleDispatch(d.data)) dispatches++; continue }
      }
      if (kind.startsWith('movement')) {
        const m = raiFactorySuiteMovementSchema.safeParse(item)
        if (m.success) { if (await handleMovement(m.data)) movements++; continue }
      }

      const a = raiFactorySuiteAlertSchema.safeParse(item)
      if (a.success && (kind.startsWith('alert') || !kind)) { alerts.push(a.data); continue }

      unmapped.push(item)
    }

    const result = alerts.length > 0 ? await ingestAlerts(alerts, 'webhook') : null
    const wialon = wialonNotifications.length > 0
      ? await ingestWialonNotifications(wialonNotifications)
      : null

    if (unmapped.length > 0) {
      logger.info(
        { event, count: unmapped.length, sample: unmapped[0], keys: Object.keys((unmapped[0] ?? {}) as object) },
        'Webhook event received that we do not map yet',
      )
    }
    sendSuccess(res, {
      event,
      received: items.length,
      alerts:   alerts.length,
      dispatches,
      movements,
      sales,
      weighments,
      workPlans,
      workshop,
      register,
      repeats,
      wialonNotifications: wialon?.created ?? 0,
      ignored:  unmapped.length + unused,
      ...(result ?? {}),
    })

    // The reply has gone: a failure from here on is logged, never sent.
    for (const work of afterReply) {
      try {
        await work()
      } catch (err) {
        logger.warn({ err, event }, 'Webhook follow-up failed after the reply')
      }
    }

    const source = webhookSourceOf(req)
    if (result || dispatches || movements || sales || weighments || workPlans || workshop || register || wialon) {
      logger.info(
        { event, source, dispatches, movements, sales, weighments, workPlans, workPlanOrgs, workshop, register, repeats, wialon, ...(result ?? {}) },
        'Provider webhook processed',
      )
    } else if (repeats) {
      logger.info({ event, source, repeats }, 'Webhook repeat ignored')
    }
  } catch (err) {
    if (res.headersSent) {
      logger.warn({ err }, 'Webhook failed after the reply')
      return
    }
    next(err)
  }
}
