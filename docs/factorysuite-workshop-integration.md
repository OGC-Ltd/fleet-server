# FactorySuite Auto Workshop → repair workflow

**Decision (operator, 2026-11-18): "feed our workflow".** FactorySuite's workshop
job cards become repair jobs in our Vehicle Support and Repair Workflow
(`vehicle-support-repair-workflow-plan.md`). They do not run as a separate
mirror beside it. Only MUFINDI PAPER MILLS (our KASULU) uses the module.

## Feeds (external API, `X-API-Key`), probed 2026-11-18

| Feed | Rows | Notes |
| --- | --- | --- |
| `GET /workshop/job-cards` | 247 (since FactorySuite's 9 Nov reset) | Ignores from/to, limit and factoryCode, so it returns everything. `machine` = the `/machines` reference = `vehicles.equipment_reference` (247/247). Costs are always null. |
| `GET /workshop/breakdowns?from&to` | 2 a month | Both dates are required, and the window is at most 31 days. |
| `GET /workshop/requisitions` | 0 | The shape is unknown, so rows are stored raw. |
| `GET /workshop/parts` | ≥1000 | Returns 1000 rows at most, with no paging. 997 of the first 1000 show zero stock; cost and supplier are empty. |

There is **no stores endpoint** for the key (`/stores`, stock movements, services due and technicians all return 404).

Times carry no offset. They are East Africa wall clock (UTC+3): activity runs 06:00–19:00 and peaks at 07:00.

Webhook events (opt-in in FactorySuite, on the `/webhook/rai` hook): `breakdown.confirmed`, `jobcard.opened`, `jobcard.released`, `requisition.raised`, `requisition.decided`, `requisition.issued`, `part.below_minimum`. Each one triggers a re-read; the payload itself is not trusted for state.

## How a card moves a job

`src/modules/repairs/factorysuite-workshop.sync.ts` (pure mapping: `src/providers/raifactorysuite/raifactorysuite.workshop.ts`).

| Card | Our job |
| --- | --- |
| Checked in (first seen) | **Adopts** an open job if one exists: first a job on the unit that is waiting to reach the workshop (pending, forwarded, awaiting_assessment, booked or towing; any category), then an open job of the card's own category. Otherwise a **new** job is created. The new job is `outcome flagged`, `queue workshop`, `path physical`, gets an RT ticket, and its fault category comes from the card's text. The report is `source = 'factorysuite'` with no author. A live booking becomes `arrived`. |
| Repair started / parts received | `fixing` |
| AWAITING_PARTS, or parts requested and not yet received | `spare_outsourced` |
| RELEASED | `completed` (test pass, fixNote = the diagnosis). **The Control Room still verifies.** A "Released from the workshop: verify it" notice is sent. |
| CANCELLED | `void`, but only if the card raised the job. A job we flagged gets a trail note and stays open. |
| Released more than 24 h before we first see it | History: filed closed as `fixed`, verified by the release, with no notice. |
| Breakdown CONFIRMED, not yet carded | A flag at `awaiting_assessment`. The card adopts it when it opens. |

Rules:
- A job only ever moves **forward**.
- It moves only when the card's stage differs from `factorysuite_job_cards.applied_stage`. So when verification is rejected (back to `fixing`), the next pass does not complete it again.
- The first reconcile pass is silent.
- Every pass emits `repair_changed`.

Parts: `factorysuite_parts` is replaced from the feed hourly (or on `part.*`) and serves `GET …/repairs/factorysuite/parts?q=&low=1`, the stores part picker.

Reads: `GET …/repairs/factorysuite/board?days=7` (open cards plus a summary) and `GET …/repairs/factorysuite/vehicles/:vehicleId/job-cards`. Item reads carry `fsJobCards`, and the ticket carries the full card.

## Deploy

1. Apply migration `20261118120000_factorysuite_workshop` on the box first, using the scratch-dir recipe.
2. Deploy the server. The reconcile loop does the backfill on its first pass: about 230 released cards are filed as history, and the open ones become open jobs.
3. Opt in to the workshop events on the FactorySuite webhook.

## Open with FactorySuite

- Paging on `/workshop/parts`.
- A stores endpoint (which store holds a part).
- Requisition line items.
- Job card costs.
- A `limit`/window on job cards before the feed grows past what one read can carry.
