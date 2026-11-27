# Fuelling plan vs actual

One day at Mufindi Paper Mills (Kasulu): every machine an approved work plan or
vehicle request asked fuel for, against what FactorySuite's pumps put in. Built
on 2026-11-27 after FactorySuite's own "Fuelling: plan vs actual" report, whose
figures it reproduces.

On the site it is **Reports › Movements › Fuel › Fuelling Plan**, shown to
organisations with a FactorySuite factory (KASULU) and the `fuel_filling:read`
right.

## Routes

Both routes require `fuel_filling:read`:

| Route | Answer |
|---|---|
| `GET /api/v1/organisations/:orgId/planner/fuelling-plan?day=YYYY-MM-DD` | The day's figures as JSON, with `lead`, the opening sentence |
| `GET /api/v1/organisations/:orgId/planner/fuelling-plan.pdf?day=YYYY-MM-DD` | The same day as a PDF |

An organisation with no FactorySuite factory gets `{ factory: null, day }` from
the JSON route and a 404 from the PDF route. The PDF is drawn on the report
worker pool (`pdf.fuellingPlan` in `lib/offload/cpu-tasks.ts`).

Code: `src/modules/planner/fuelling-plan.ts` (the figures, pure),
`fuelling-plan.pdf.ts` (the PDF), and `planner.controller.ts`. The site's tab
is `new-ui/src/components/screens/FuellingPlanReport.jsx`.

## Where the data comes from

It is built from the Fuel page's read, `factoryFuelFor` (`factory-fuel.ts`), for
the one day:

- **Plan lines**: FactorySuite `/fuel/plans`, duplicates collapsed (`collapsePlans`).
- **Fuel requests**: `/fuel/requests`, joined to a line by machine, day and shift.
  When two requests share a machine-shift, the approved one stands (DG-03, 25 Nov:
  a rejected request, then an approved one the pump filled).
- **Vehicle requests**: requests no plan line names (Transport's buses and hired
  vehicles, Security, some Land Dev). They are kept on `factory-fuel` as
  `vehicleRequests`, apart from `lines`, so the Fuel page still counts plan lines
  as FactorySuite does.
- **Fuellings**: `/fuel/issues` merged over the kept `factorysuite_fuel_issues`.
- **Types**: the machine register's category, else its name, else "Unspecified".

## How the figures are worked out

| Figure | Rule |
|---|---|
| Planned machine | On a plan line whose plan **and** fuel request are approved (a line whose request is not released yet counts on its plan), or on an approved vehicle request. A machine on two shifts is one machine. |
| Planned litres | The fuel request's litres, else the line's own figure. A machine's shifts are added. A full tank with no figure anywhere is "Full tank": it counts in machine totals, never in a litre total or a percentage. |
| Fuelled | The day's completed fuellings at the pumps, by machine. |
| Status | **Fuelling now** (a fuelling still open), **Not fuelled**, **Short** (more than 10% under), **Over** (more than 10% over), **As planned** (within 10%; a full tank once fuelled). |
| Litres delivered | Litres fuelled on plans with a litre figure, as FactorySuite counts it. Litres into full tanks are told apart in the opening sentence. |
| Shortfall | Planned less fuelled, over the Short machines. |
| Fuelled off plan | Machines fuelled that day that no counted plan or request names; listed apart, never in the planned totals. |
| Not counted | Lines whose plan or request still waits for approval (`pendingLines`) or whose request was rejected or cancelled (`rejectedLines`). |

**Site** is the plan line's fuelling location. FactorySuite's API gives a vehicle
request no site, so it takes the pump that fuelled it that day, else the pump it
was last fuelled at in the 30 days before (kept issues), else it is grouped as
"Vehicle requests, no site".

The day is **closed** once it is before today in East Africa time; until then
the wording says "so far".

## The PDF

Drawn like the Logbook's PDF (`usage-review.pdf.ts`): the Rai Group and OGC
logos, a cover head and a strip with the day, number of sites, state, when it
was prepared and by whom. Then, flowing onto new pages only when a section does
not fit:

1. The opening sentence, figures in bold, and five tiles: machines fuelled,
   litres delivered, not fuelled, fuelled short, as planned.
2. **Where every planned machine stands**: one bar by status.
3. **Progress by site**: machines fuelled of machines planned.
4. **Litres by equipment type**: litres fuelled against litres planned.
5. **Machines fuelled: how close to plan**: each fuelled machine's plan as a
   track and what went in as the fill, biggest shortfall first.
6. **Fuelled off plan**, when there are any.
7. **Machine list**: every planned machine by status, the table head repeated
   on each page.
8. **How these numbers are worked out**.

Status colours follow FactorySuite's: red not fuelled, amber short, green as
planned (violet over, sky blue fuelling now).

## The page

The five figures in the header; Today, Yesterday or any one day from the
calendar; the opening sentence; the status bar, whose key filters the machine
list; progress by site and litres by type side by side; a machine search; and
the machine list grouped by status. CSV follows the filters on screen; PDF,
JPEG and Preview are always the whole day.

## Checked against FactorySuite

On 25 Nov 2026 it gives FactorySuite's own report figure for figure: 48 of 142
machines fuelled, 5,960 L against 31,765 L planned, 94 not fuelled (10 of them
full tanks), 29 short (7,469 L under), 19 as planned. The one difference is
sites for vehicle requests: FactorySuite places them at Logistics Centres 1
and 2 from data its API does not give, so the site named as having the most
machines still waiting can differ.
