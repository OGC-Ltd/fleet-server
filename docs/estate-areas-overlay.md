# Estate areas map overlay — discovery, plan, execution

**Goal.** A toggle on the fleet map that shows the Kasulu Sugar Estate areas —
the ones drawn in `ESTATE AREAS TO BE PLANTED-Model.pdf` and
`ESTATE BOUNDARIES.dwg` — as they sit on the ground.

Status: Tier 1 built. Tier 2 blocked on a DXF export (see
[Open question](#open-question--the-dxf-export)).

---

## 1. Discovery — what the two documents actually are

### The PDF

`ESTATE AREAS TO BE PLANTED-Model.pdf` is a single-page AutoCAD model-space
plot titled **"KASULU SUGAR ESTATE PLANTING AREAS 2026-2027"**. It is fully
vector — 513,469 line segments, 55,465 curves, 22,299 glyphs — not a scan.

It carries three levels of detail:

| Level | Content |
| --- | --- |
| Macro areas | ZONE 3, ZONE 4 (2320 ha), COMMERCIAL (1296 ha), NURSERY A, NURSERY B (664.36 ha), RAIN FED AREA, FACTORY, Hill Area (423 ha) |
| Harvest/hydraulic blocks | HC#3.2.1, HC#3.2.2, HC#3.3.1, HC#3.3.2, HC#3.4.1, HC#3.4.2, HC#3.5.1, HC#3.5.2, HC#3.6.1, HC#3.6.2 (270.8 ha), IRR 4.1–4.3, B1–B4 |
| Field blocks | Thousands of individual plots labelled `ZONE 4 - 1` … `ZONE 4 - 60+`, each classified by land use |

The land-use classification in the key is the operationally interesting part:
**PLANTED (637 ha)**, PROPOSED TO BE PLANTED, **ROCKY** (250.04 ha commercial +
175 ha zone 4 + 641.8 ha zone 3), **SWAMPY** (22.32 ha / 144.55 ha), WET FIELDS
(6.21 ha), FACTORY AREA (330.13 ha), RAIN FED (250 ha), RESERVOIR (4.5 ha),
BORROW PIT (31.92 ha), LOGISTICS 2 (20.99 ha).

**The PDF has no coordinate system.** It is a plot in paper space. Nothing in
it states a datum, grid, or scale bar with coordinates.

### The DWG

`ESTATE BOUNDARIES.dwg` is **AC1032** (AutoCAD 2018 format), 6.3 MB.

The important finding: a raw scan of the binary for adjacent little-endian
double pairs in a plausible East-African UTM window recovered 253 vertices,
all clustered in a single tight window:

```
E [212,262.7 .. 224,931.0]   span 12,668 m
N [9,551,231.3 .. 9,558,920.3]  span  7,689 m
```

That is **UTM Zone 36S**. Converting the corners back:

```
E 212,262 / N 9,551,231  ->  lng 30.409, lat -4.058
E 224,931 / N 9,558,920  ->  lng 30.523, lat -3.989
```

which lands exactly on top of the Kasulu factory / haulage-road / Zone 3
cluster already in our geofence table.

**This is the single most important discovery: the CAD is georeferenced.**
There is no rubber-sheeting, no manual control-point picking, no "drag the
image until it looks right". CAD model coordinates convert to WGS84 with a
closed-form UTM-36S inverse. (Only 253 of the drawing's vertices were
recoverable by raw scan because AC1032 compresses most section data — enough to
prove the CRS, not enough to rebuild the geometry. That is what the DXF export
is for.)

Residual risk: the datum could be **Arc 1960** rather than WGS84 — still common
for Tanzanian survey work, and worth roughly a 150–300 m systematic shift. That
is testable the moment we have real CAD geometry (see §5).

### What is already in the database

`geofences` holds **107 rows for KASULU**, imported from Wialon geozones by
`npm run sync:geofences`:

| Stored type | Count |
| --- | --- |
| CIRCLE | 67 (all `VES-nnn`, r = 1000 m — village/estate sample points) |
| POLYGON | 18 (factory, logistics centres, staff residence, workshops, swamps, wet land, reservoir) |
| LINE | 22 |

**And here is the bug.** Of the 22 rows stored as `LINE`, eleven are not
corridors at all — they are **closed area rings** that Wialon happens to store
as type-1 polylines, and `sync-geofences.ts` imported the Wialon type verbatim:

```
name                     pts   width   closure gap   ring area
2500 Ha Area               9     1 m         0 m       2,354 ha
Commercial Area            6     1 m         0 m       1,734 ha
FARM#210                 371     3 m         0 m       8,168 ha
FARM#211                 254     3 m         0 m      16,374 ha
FARM#212                 377     3 m         0 m       3,455 ha
FARM#213                 282     3 m         0 m       2,979 ha
FARM#214                   6     3 m         0 m       3,165 ha
FARM #215                 80     3 m         0 m       3,650 ha
Nursery A                  5     1 m         0 m         130 ha
Nursery - B               10     1 m         0 m         736 ha
Rainfed Area               9     1 m         0 m       1,933 ha
```

Every one closes exactly on itself (first vertex == last vertex, gap 0 m). A
zone named "2500 Ha Area" whose ring encloses 2,354 ha is an **area**, not a
1-metre-wide corridor. The remaining eleven `LINE` rows — DRAINS1–5, the three
Malagarasi river traces, the two haulage roads — have closure gaps of 1–29 km
and are genuine corridors.

So: **the estate areas the user wants to see are already in the database.** They
just cannot be drawn as areas, because they are typed as corridors.

Matching them against the PDF's own stated hectares confirms they are the same
features:

| PDF label | PDF ha | Wialon ring ha |
| --- | --- | --- |
| ZONE 4 | 2,320 | 2,354 ("2500 Ha Area") |
| NURSERY B | 664.36 | 736 ("Nursery - B") |
| COMMERCIAL | 1,296 planted / 1,600 label | 1,734 ("Commercial Area") |

Within a few percent — the ring is the outer envelope, the PDF figure is the
plantable subset. Same features.

---

## 2. Advice — three ways to integrate, and which to take

### Option A — Vector overlay from the geofences we already hold ✅ recommended

Fix the ring typing, serve the zones as GeoJSON, draw them as Google Maps
polygons behind a toggle.

- No CAD parsing, no new dependency, no georeferencing step.
- Zones stay clickable and queryable, and they are the *same rows* the
  violation engine uses — the map shows what is actually enforced, so the
  overlay and the alerts can never disagree.
- Re-running `sync:geofences` keeps it current from Wialon.
- Ceiling: only the ~29 macro areas. No field blocks, no HC# sub-blocks, no
  rocky/swampy land-use shading.

### Option B — Georeferenced raster overlay (Google `GroundOverlay`)

Rasterise the PDF's drawing area, warp it onto the map using the UTM-36S
corners.

- Visually exact — it *is* the drawing, including every label.
- But: not clickable, not queryable, doesn't reproject cleanly at high zoom,
  fights the satellite basemap visually, and needs a re-render every time the
  planting plan is revised. It looks impressive and ages badly.
- Reasonable as a one-off visual cross-check. Not a product surface.

### Option C — Full vector import from DXF

Convert the DWG to DXF, walk it with `ezdxf`, project UTM-36S → WGS84, and
import the field blocks with their layer-derived land-use class.

- The end state: every plot on the map, colour-coded by planting status,
  clickable, joinable to vehicle activity ("which trucks worked HC#3.3.1
  today?").
- Requires a DXF export (see below), plus decisions on where the blocks live —
  they are *reference cartography*, not geofences, so they want their own table
  rather than polluting `geofences` with 3,000 unenforced rows.

**Recommendation: A now, C next, B never.** A is a day's work on data we already
own and it makes the map immediately useful. C is the real prize but is gated on
an export we cannot produce on this machine.

---

## 3. Plan

### Backend

1. **Classify closed rings at import.** In `prisma/sync-geofences.ts`, a Wialon
   type-1 zone whose first and last vertices coincide becomes `POLYGON`, not
   `LINE`. This must live in the sync, not just in a one-off UPDATE — otherwise
   the next `sync:geofences` silently reverts it, because the update path writes
   `type`.
2. **Backfill the existing rows** with `prisma/fix-ring-geofences.ts`, dry-run by
   default, `--apply` to commit.
3. **Serve GeoJSON.** `GET /organisations/:orgId/geofences/geojson` returns a
   `FeatureCollection`, circles approximated as rings, corridors as
   `LineString` with their width in properties, plus a derived `category` used
   for styling.

Safety note: all eleven mis-typed rings are `is_active = false`, so none is
currently enforced — the only enforced zones are the drains and rivers, which
are genuine corridors and are left alone. Retyping changes no alerting
behaviour today. It *does* fix a latent bug: activating "2500 Ha Area" as a
keep-in zone today would test containment against a 1-metre corridor and fire
on all 224 vehicles at once.

### Frontend (`dash`)

4. `useEstateZones(orgId)` — fetch once, cache, no polling. Zone geometry
   changes on the order of months.
5. Draw with `google.maps.Polygon` / `Polyline` on the existing map instance,
   in a ref-held layer torn down on unmount, mirroring how `routeLayerRef`
   already works.
6. A toggle control, off by default, with a compact legend.

### Performance constraint

`Main river malagarasi3` alone is 2,414 vertices; the full set is ~8,600. That
is fine for one static draw, but it must **not** be re-created on every fleet
reconcile — the map already learned this lesson once (see the
`dash-map-performance` notes). Build the layer once when the data and map are
both ready, then only flip `visible`.

---

## 4. Execution log

- `prisma/sync-geofences.ts` — ring-closure classification added.
- `prisma/fix-ring-geofences.ts` — new backfill script, `npm run fix:rings`.
- `src/modules/geofences/geofence.controller.ts` / `.routes.ts` — `geojson`
  endpoint.
- `dash/src/hooks/useEstateZones.js` — new.
- `dash/src/components/body/FleetMap.jsx` + `.css` — overlay layer and toggle.
- `dash/public/estate-plan.geojson` — the CAD planting plan, vector-extracted
  from the PDF and georeferenced (indicative — see Tier 2 below).
- Zone name plates reworked and cross-checked against the drawing — see §6.

---

## 5. Verification

**Classification accounts for every row.** 22 `LINE` rows = 11 rings + 11
corridors + 0 guarded. The rings enclose 130–16,374 ha; the corridors' endpoints
sit 1.0–29.2 km apart. No row was silently dropped.

**Area maths is sound.** The server computes hectares with a shoelace on a local
equirectangular projection. Cross-checked against a spherical-excess geodesic
area — an independent formula, not the same maths twice — the two agree to
**0.09 % worst case** across all 29 polygons.

**The geometry is the surveyor's geometry.** Against the hectares printed on
the drawing:

| Drawing | Printed | Wialon ring | Δ |
| --- | --- | --- | --- |
| ZONE 4 | 2,320 ha | 2,354 ha | +1.5 % |
| COMMERCIAL | 1,600 ha | 1,734 ha | +8.4 % |
| NURSERY B | 664.36 ha | 736 ha | +10.8 % |

The rings run a few percent large because a ring is the outer envelope while
the printed figure is the plantable subset inside it — exactly the expected
direction and magnitude.

**The fix survives a re-sync.** `npm run sync:geofences` was re-run against live
Wialon after the backfill. It re-derived all 11 reclassifications independently
and produced a byte-identical GeoJSON payload (299,544 bytes before and after).
Final state: 29 POLYGON / 11 LINE / 67 CIRCLE, no unclosed rings, no polygon
left carrying a stale `widthM`.

**Enforcement is untouched.** The same 8 fences are active before and after —
DRAINS1–5 and the three Malagarasi traces, all genuine corridors. 1,792 vehicle
bindings unchanged.

`npm test` — 117 passed, 4 skipped. `npm run build` (dash) — clean.

### Two bugs that made the layer look broken

Both found only after the layer was reported working. Neither was a drawing
fault — the shapes were correct and attached the whole time.

**1. The camera never went to the estate.** The map opens fitted to the whole
fleet. Kasulu's cached positions span lng 30.1–39.3 / lat −6.9–0.03 — a
thousand kilometres — so the camera sat at zoom 6 centred ~936 km away. The
estate is 12 km across: every zone drew correctly and occupied about five
pixels, off-screen. Enabling a layer now fits the camera to its bounds.

**2. `fitBounds` is silently dropped when the map is busy.** Measured directly:
the *identical* bounds object on the *identical* map instance landed on
(33.50, −3.24) called inline from the React commit, and on (30.35, −4.01)
called a moment later. Two follow-on races came out of the same root — the
cleanup cancelling its own pending fit, and a one-shot `idle` listener racing
the fit and leaving labels hidden at the old zoom. All three are handled by
`fitMapToBounds()`: defer a frame, nudge a resize, fit, then verify on idle and
re-fit if the camera did not land. Labels re-evaluate on a persistent `idle`
listener rather than a one-shot.

**3. The controls were buried.** `MapOverlay` pins a 336 px panel down the left
and a 340 px panel down the right, both full-height at `z-index: 400`. The
toggles sat in the top-left corner at `z-index: 5` — underneath. They now sit
in a row across the top-centre band, the only clear space, above the panels.

### Rendering

Google Maps cannot be made to paint in either available browser surface — the
Browser pane does not composite frames (`.gm-style` is never created; the
production vehicle markers are equally absent, which is the control proving it
is environmental), and the Chrome extension is not connected.

So the layer was verified by **rendering the live `/geofences/geojson` payload
directly**, using the same palette, the same `ZONE_SKIP_CATEGORIES`, and the
same `ZONE_LABEL_MIN_HA` rule the component applies: 29 polygons, 11 corridors,
17 labels, 67 VES points correctly skipped. This tests the thing that could
actually be wrong — the geometry — more directly than a screenshot would.

The result matches the surveyor's plan feature for feature:

| Drawing | Overlay |
| --- | --- |
| FACTORY, centre-left | `Factory site Location` 138 ha, 30.42 / −4.04 |
| COMMERCIAL 1600HA, east of factory | `Commercial Area` 1,734 ha, 30.47 |
| NURSERY A / B, far east | 130 ha + 736 ha, 30.54 |
| RAIN FED AREA, south | `Rainfed Area` 1,933 ha, −4.08 |
| Malagarasi along the NE boundary | river corridor tracing FARM#210's east edge |

**Defect found and fixed by that render: label collisions.** The zones NEST —
FARM#211's 16,374 ha envelope contains the factory, the 2500 Ha block and both
nurseries — so at estate-wide zoom their centroids fall within a few pixels and
the name plates stacked into an unreadable pile. Labels are now gated at
`ZONE_LABEL_MIN_ZOOM = 11`, re-evaluated on `zoom_changed`; shapes still draw at
every zoom, and the legend says so. Re-rendered at working zoom, all seven
labels in the factory/commercial/nursery cluster separate cleanly.

Still worth a human glance in a real browser for the things only a live map can
show — z-order against the satellite basemap, and the overlay's interaction
with vehicle markers on top of it.

**Datum check (deferred to Tier 2).** Once the DXF lands, overlay the CAD
factory outline on the Wialon `Factory site Location` polygon and measure the
residual. Near-zero means the CAD is WGS84 and the UTM inverse is sufficient. A
systematic ~200 m offset in a consistent direction means Arc 1960, and the
import needs a datum transformation before the blocks will line up.

---

## 6. Zone labels — cross-checked against the drawing

Two questions, answered together: does every zone on the overlay carry a name,
and does the name agree with the surveyor's sheet?

### The drawing's KEY panel, transcribed

Extracted from the PDF's own key (left column, x 121–520 pt). Four macro areas,
each broken down by land use:

| Macro area | Land-use rows |
| --- | --- |
| NURSERY B (664.36 ha) | PLANTED AREA 637 ha · WET FIELDS 6.21 ha · ROCKY AREA 21.15 ha |
| COMMERCIAL (1296 ha) | PROPOSED AREA TO BE PLANTED 1296 ha · ROCKY AREA 250.04 ha · LOGISTICS 2 20.99 ha · BORROW PIT 31.92 ha |
| ZONE 4 (2320 ha) | PROPOSED AREA TO BE PLANTED 2320 ha · ROCKY AREA 175 ha · SWAMPY AREA 22.32 ha · FACTORY AREA 330.13 ha · RAIN FED 250 ha · RESEVOIR 4.5 ha |
| ZONE 3 | PROPOSED AREA TO BE PLANTED · AVAILABLE AREA 2120.38 ha · HILL AREA 423 ha · HC 362 AREA 270.8 ha · ROCKY AREA 641.8 ha · SWAMP 144.55 ha |

### Name concordance

Wialon carries the operators' names, the sheet carries the surveyor's, and
nothing links them. `ZONE_PLAN_ALIAS` in `FleetMap.jsx` is that link — the plate
shows both, and the popup adds the hectares the drawing prints:

| Zone (Wialon) | Ring ha | Drawing | Printed ha | Δ |
| --- | --- | --- | --- | --- |
| 2500 Ha Area | 2,354 | ZONE 4 | 2,320 | +1.5 % |
| Commercial Area | 1,734 | COMMERCIAL | 1,296 | +34 % |
| Nursery - B | 736 | NURSERY B | 664.36 | +10.8 % |
| Nursery A | 130 | NURSERY A | — | — |
| Factory site Location | 138 | FACTORY AREA | 330.13 | **−58 %** |
| Rainfed Area | 1,933 | RAIN FED | 250 | **+673 %** |
| Reservoir site | 3 | RESEVOIR | 4.5 | −33 % |
| Logistic centre2 | 13 | LOGISTICS 2 | 20.99 | −38 % |

The first four are the expected direction and magnitude — a ring is the outer
envelope, the printed figure the plantable subset inside it. The last four are
not reconcilable that way and are shown side by side rather than picked between:
`Rainfed Area` is an 8× envelope around a 250 ha allocation, and
`Factory site Location` is *smaller* than the drawing's factory area, so the two
are measuring different things. Neither figure is ours to overrule.

### Zones the drawing does not corroborate

Six zones fall wholly outside the drawing's extent (plan bbox lng 30.3625–30.5453,
lat −4.0782–−3.9481), 12–20 km west of the sheet:

`FARM#212`, `FARM#213`, `Swamp area1`, `Swamp area2`, `Swamp area3`,
`Wet area1`, `Wet land2`.

This is the basis for suppressing the two wet-land plates
(`ZONE_LABEL_SUPPRESS`): the drawing's only wet-ground class anywhere is
**WET FIELDS 6.21 ha** inside Nursery B, against `Wet land2` at 1,110 ha and
`Wet area1` at 254 ha — three orders of magnitude apart, on ground the surveyor
never drew. The polygons still draw and still answer a click; they no longer
assert a name. Nothing in the drawing, the geofence table or the code contains
the phrase "proposed wet land location" — the plates that read closest to it are
`Wet land2` and `Proposed labour camp Location` (181 ha, a facility inside the
plan extent, kept).

### Coverage

The old rule labelled polygons over 100 ha only, which left 13 zones nameless —
the workshops, dispensary, staff residences, Agriculture Lab, reservoir, both
logistics centres, the small swamps — and never labelled a corridor at all. The
size test was a collision test in disguise, so collisions are now handled
directly (`declutterLabels`: priority by area, biggest keeps its centre, a
plate may step to a free slot at z ≥ 15) and the gate is a zoom ladder
(`ZONE_LABEL_TIERS`, corridors at z ≥ 13 on a length-midpoint).

Verified by replaying the live `/geofences/geojson` payload through the same
ladder, priority order and collision maths the component uses (Google Maps
cannot paint in either available browser surface — see Rendering above):

| Zoom | Eligible | Shown | Suppressed by collision |
| --- | --- | --- | --- |
| 11 | 9 | 8 | 1 |
| 12 | 15 | 12 | 3 |
| 13 | 26 | 20 | 6 |
| 14 | 29 | 29 | 0 |
| 15 | 38 | 33 | 5 |
| 16 | 38 | 35 | 3 |
| 17 | 38 | 37 | 1 |
| 18 | 38 | 38 | 0 |

40 zones drawn, 38 plates built (2 suppressed by name), and **every plate is
placed by z18**, the map's maxZoom. Without the nudge, `Dispensary` never got
one: it sits with the two workshops, both staff residences and the Agriculture
Lab inside ~200 m east of Nursery A, several of them under a hectare. Nudges
stay within two plate-heights (≤ 58 px, ~20 m at z18) and only ever move into
empty space.

---

## Tier 2 attempt — georeferencing the PDF directly (did not succeed)

Tried, because the DXF was not available. Two useful things came out of it, and
one hard negative.

### What worked: the geometry IS fully extractable

The complete drawing reconstructs cleanly from the PDF's **`curves`**, not its
`lines`. This matters and is not obvious:

- `page.lines` yields 513,469 segments that are almost entirely **hatch fill**
  (the red rocky-area hatching, the green factory hatch, the swamp hatch). Plot
  them and you get hatching with no boundaries. A dead end.
- `page.curves` yields 54,767 paths that reconstruct the whole drawing — every
  field block, the estate outline, the river meander, the north arrow.

Parsing costs ~190 s, so cache it (`pickle`) before iterating.

### What failed: nothing anchors it to the ground

The PDF is a plot; it carries no CRS. Three independent methods were tried for
control points, and all three failed for different reasons:

| Method | Result | Why it failed |
| --- | --- | --- |
| Text label anchors (FACTORY, Nursery A/B, COMERCIAL, RESEVOIR) vs Wialon centroids | **RMS 1,331 m** | The labels are callout boxes placed at block *edges*, not centroids. Error is dominated by label placement. |
| Shape-matching simplified PDF paths against Wialon rings | **spurious** | Unconstrained by scale: `Commercial Area` (1,734 ha) "best-matched" a 29×25 pt box worth ~9 ha. Rectangles are degenerate — every 4-vertex zone matches every field plot. |
| ICP against the Malagarasi | **degenerate** | Converged to 88 m *against the river* while the independent control residuals got **worse** (1,331 → 1,652 m) and scale drifted 10.6 → 9.5 m/pt. A river is a 1-D feature: ICP slides the drawing freely along its tangent. The good-looking number is an artefact. |

The best honest transform is ~**10.6 m per PDF point, rotation −3.6°**, accurate
to roughly **±1.5 km**. The drawing lands in the right neighbourhood — Zone 3
north-west, factory centre, Commercial east, nurseries far east — but a field
block is 100–300 m across, so a 1.5 km error puts every block in the wrong
field.

### Shipped anyway, as a clearly-marked separate layer

On instruction, this was integrated — but deliberately **not** as an equal of
the geofence layer:

- Its own toggle, **"Planting plan"**, separate from "Estate areas", off by
  default, in a different accent colour.
- A warning panel is the first thing in its legend: *"⚠ Indicative only —
  approximately ±1.5 km. Traced from the 2026-27 planting drawing, which
  carries no coordinate system. Use for orientation, never as a boundary."*
- `clickable: false` and `zIndex: 0` — it cannot be interrogated like a real
  zone, and it always sits beneath both the authoritative zones and the fleet.
- Served as a static asset (`dash/public/estate-plan.geojson`, 1.6 MB, 9,496
  paths) and **lazily fetched on first toggle**, so sessions that never open it
  pay nothing. Deliberately NOT written into the `geofences` table: it is not
  authoritative and must never be mistaken for something the violation engine
  could evaluate.
- Rendered through `google.maps.Data` rather than 9,496 hand-built Polylines,
  and hidden rather than discarded on toggle-off — re-parsing that many
  features on every flip stalls the map for seconds.

The error is visible rather than hidden: with both layers on, the plan's river
trace runs about a kilometre off the surveyed Malagarasi, and the Rain-fed
geofence box contains almost none of the plan's rain-fed block. That is the
honest state of the fit, and it is why the caveat is in the UI and not just in
this document.

### The underlying problem

There is no feature present in both the PDF and our data that is simultaneously
(a) precisely locatable and (b) two-dimensionally constraining. And even a
perfect fit would be capped by the accuracy of the Wialon rings themselves,
which are 5-to-9-vertex hand digitisations being used as ground truth.

### What unblocks it

Either of these makes Tier 2 straightforward — the extraction machinery is
already proven:

1. **The DXF** (preferred). The DWG carries UTM Zone 36S natively, so this is a
   closed-form inverse with no fitting at all — see §1.
2. **Two accurate ground control points.** Real WGS84 coordinates for any two
   identifiable points on the drawing (factory gate, a named block corner, a
   survey beacon) pin scale, rotation and translation exactly. A handheld GPS
   reading at two known corners would do it.

---

## Open question — the DXF export

Tier 2 needs `ESTATE BOUNDARIES.dwg` as **DXF**. This machine has no DWG reader:
no ODA File Converter, no LibreDWG, and `ezdxf` (now installed) reads DXF only.
I did not download a converter — that is a binary install decision for you, not
something to do silently.

Two ways forward, whichever is easier:

1. **Re-export from AutoCAD/Civil 3D** — `SAVEAS` → *AutoCAD 2018 DXF (\*.dxf)*.
   ASCII DXF is preferred; binary is fine too. Please keep layer names intact,
   they are what carries the land-use classification.
2. **ODA File Converter** — free from the Open Design Alliance, converts DWG →
   DXF in batch. Say the word and I will lay out the exact steps.

Worth confirming at the same time: **what coordinate system the surveyor set the
drawing in** — specifically whether it is WGS84 / UTM 36S or Arc 1960 / UTM 36S.
The title block or the surveyor's transmittal usually says. It saves guessing at
a 200 m offset later.
