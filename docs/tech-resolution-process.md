# Tech Resolution Process — revised, and what the Ops App actually does

**Source**: *Tech Resolution Process*, process walkthrough, September 2026 (4 pages).
**Status**: the walkthrough is the business's description of the loop. This
document is that loop restated as states and events, the places it is
under-specified, and — section by section — what the Ops App implements today
and what it does not. Written 2026-09-19 against `src/modules/repairs`.

---

## 1 · The loop as the walkthrough draws it

Five parties, one ticket:

| Lane | Who |
| --- | --- |
| Operations Team | OGC, CT, KASULU — the people at the unit |
| Operations Room | triage, deployment, order follow-up (Mombasa) |
| RAI Security | availability and vehicle; **gates** deployment |
| CT Engineer | attempts the repair |
| Stores Team | holds spares, provides them, updates the app |

The sequence:

1. **Problem identified** (Operations Team)
2. **Report issue in Ops App** (Operations Team)
3. **Investigate & deploy** (Operations Room), with **automatic assignment** to a CT Engineer
4. **Check RAI Security availability & vehicle** — *"an unavailable team or missing vehicle delays deployment"*
5. **Attempt repair** (CT Engineer)
6. **Spares needed?**
   - **No** → issue resolved
   - **Yes** → **log spare request in Ops App** *while repair work continues* → **check spare availability**
     - **on site** → collect spares from Stores
     - **order** → order spare → **follow up on order** (Operations Room Mombasa); *"ordered spares add lead time"*
   - → **Provide spares & update Ops App** (Stores Team)
7. **Issue resolved** → **close ticket in Ops App**
8. **Escalate if unresolved after X days** — *"escalated beyond this product's owners"*

And the sentence the whole document turns on:

> **Nothing leaves the loop silently — a ticket is either closed in the Ops App or escalated.**

---

## 2 · Nine things the walkthrough does not say

These are not objections to the process. They are the decisions a system has to
make that a flowchart does not, and each one is a place where a ticket can
currently go quiet.

**2.1 Where a ticket begins.** The walkthrough starts with a person noticing a
problem. Half of this fleet's problems are noticed by the fleet: a probe stops
reporting and the platform knows before anyone at the site does. Both have to
open the same object, or the automatic half never enters the loop and is never
counted in it.

**2.2 Who owns a ticket between steps 2 and 5.** "Automatic assignment" names
no one and no clock. A ticket assigned to nobody is indistinguishable from a
ticket nobody has looked at.

**2.3 The security gate is a wait, not a decision.** Step 4 can hold a ticket
for days, and the walkthrough treats it as a diamond on the way to the repair.
If the wait is not a state with a start time and a reason (no team / no
vehicle), then a repair that was blocked for three days reads afterwards as a
repair that took three days — and RAI Security's availability, which is the
thing that actually needs managing, is invisible in the record.

**2.4 A spare request is three facts, not one.** "Logged", "available on site
or ordered", and "provided" are three separate events with three different
owners, and the middle one decides whether the wait is hours or weeks. Storing
"needs a spare" and a date collapses all three.

**2.5 Lead time has no owner in the data.** "Follow up on order" belongs to the
Operations Room in Mombasa. Unless the order carries a reference, a promised
date and a named follower, the follow-up is a habit rather than a step.

**2.6 X is undefined.** "Escalate if unresolved after X days" cannot be
implemented until X is a number *and* the clock it runs on is named. There are
three candidate clocks and they give different answers:

   - since the ticket was opened → escalates jobs that are progressing normally but slowly;
   - since the last movement → escalates jobs that have gone quiet, which is the real failure;
   - past the promised date → escalates jobs whose own estimate has slipped.

   **Recommended: the last two, separately.** A ticket with no movement for
   `ESCALATE_STALE_DAYS` escalates as *stalled*; a ticket past its
   `expectedResolutionAt` by `ESCALATE_OVERDUE_DAYS` escalates as *overdue*.
   The first catches the ticket nobody is touching, the second the one whose
   estimate was wrong. Defaults proposed: **3** and **2**.

**2.7 Escalation is a state, not an email.** If escalating only sends mail, then
an escalated ticket looks identical to an open one the next morning, and the
loop's closing sentence is not true. Escalation must be recorded on the ticket,
must name who it went to, and must be visible on the board.

**2.8 There is no way out that is neither fixed nor failed.** A ticket raised in
error, or a duplicate of one already open, currently has to be closed as one of
the two outcomes — which puts a fiction into every count built on them.

**2.9 Recurrence.** The walkthrough ends at closure. A probe that fails again
next month is a new ticket; it should carry a link to the last one, because the
second failure of the same unit is a different conversation from the first.

---

## 3 · The revised state machine

One ticket per faulty target (a probe, or a fault episode on a unit). States,
in the order a ticket meets them:

| State | Means | Set by | Leaves when |
| --- | --- | --- | --- |
| `reported` | The problem is on the record. No one is assigned. | Ops team, or the platform itself from probe health | Someone is assigned |
| `assigned` | A CT Engineer owns it. | Ops Room, or automatic assignment | The team is dispatched or blocked |
| `awaiting_access` | Blocked on RAI Security: no team, or no vehicle. Carries the reason. | Ops Room | Access is granted |
| `fixing` | The engineer is at the unit. | CT Engineer | An outcome is recorded |
| `spare_requested` | A part has been named; availability is not yet known. Repair work may continue. | CT Engineer | Stores answer |
| `spare_on_site` | The part is at the store and can be collected. | Stores | The part is handed over |
| `spare_ordered` | The part is on order. Carries reference, supplier and promised date. | Stores / Ops Room | The part arrives |
| `spare_provided` | The part is with the engineer. | Stores | Work resumes |
| `fixed` | The unit is back in service. Demands an account of the fix. | CT Engineer | — terminal |
| `failed` | The unit could not be fixed here. Demands an account. | CT Engineer | — terminal |
| `void` | Raised in error, or a duplicate. Demands a reason and a link. | Ops Room | — terminal |

**Escalation is not in that column, and that is the decision.** An escalated
job is still waiting for its part; a `stage` reading "escalated" would replace
the one fact anybody chasing it needs. So escalation is an ANNOTATION on the
ticket — an entry on the same trail a stage change writes, carrying a reason
and a level — and the stage goes on saying what the job is doing. **Built**:
see `repairs.escalation.ts` and the badge on the Repairs tab.

Three rules the machine keeps:

- **Terminal means terminal.** `fixed`, `failed` and `void` never move again. A
  unit that fails afresh opens a new ticket carrying `precededBy`.
- **Escalation does not interrupt work.** An escalated ticket is still worked;
  the state records that somebody outside the loop was told, and the ticket
  returns to the working state it came from when work resumes.
- **Every transition carries who, when, and why** — and a transition nobody can
  explain is not permitted: the states that end a ticket or block it all demand
  a note.

---

## 4 · Nothing unreported: the obligation matrix

"Reported" means a durable notification in the feed, and mail where the
recipient is outside the app. A log line is not a report.

| Event | Ops Room | CT Engineer | Stores | Escalation list | Feed |
| --- | --- | --- | --- | --- | --- |
| Ticket opened (person) | ✔ | — | — | — | ✔ |
| Ticket opened (platform, from probe health) | ✔ | — | — | — | ✔ |
| Assigned | — | ✔ | — | — | ✔ |
| Blocked on access | ✔ | ✔ | — | — | ✔ |
| Spare requested | ✔ | — | ✔ | — | ✔ |
| Spare on site / ordered | — | ✔ | — | — | ✔ |
| Spare provided | — | ✔ | — | — | ✔ |
| Order promised date missed | ✔ | ✔ | — | — | ✔ |
| Closed (fixed / failed) | ✔ | — | — | — | ✔ |
| Voided | ✔ | — | — | — | ✔ |
| **Escalated** | ✔ | ✔ | — | ✔ | ✔ |
| **Daily: what is still open** | ✔ | — | — | — | ✔ |

The daily line is what makes the closing sentence true. Every other row fires on
a transition, and a ticket that never transitions is exactly the one that goes
quiet — so the loop needs one report that fires when *nothing* happened.

---

## 5 · What the Ops App does today

`src/modules/repairs` — reports, items, stages, sign-off.

| Walkthrough step | Today | Verdict |
| --- | --- | --- |
| Problem identified | Probe health derives a `pending` state on the dashboard | Partly: no row exists, so nothing can be assigned, timed or escalated |
| Report issue in Ops App | `POST /repairs` — but filed by the **technician**, after the visit | **Gap**: the ops team's report is the technician's report; steps 2–5 collapse into one |
| Investigate & deploy | — | **Gap** |
| Automatic assignment | — | **Gap**: no assignee anywhere in the schema |
| Check RAI Security / vehicle | — | **Gap**: the wait is invisible; it shows up as a slow repair |
| Attempt repair | Outcome `fixing` | ✔ |
| Spares needed? | Outcome `needs_spare` + free-text `sparePart` | Partly |
| Log spare request | Lands on stage `spare_outsourced` with `expectedResolutionAt` | Partly: request and order are one state |
| Check availability (on site / order) | — | **Gap** |
| Collect from stores / order spare | — | **Gap**: no store, no order reference, no supplier |
| Follow up on order | — | **Gap**: no owner, no chase |
| Provide spares & update Ops App | A stage change anybody with `repair:resolve` can make | **Gap**: Stores is not a role, and provision is not an event |
| Issue resolved | `POST /items/:id/resolve` with `fixNote` + verdict | ✔ |
| Close ticket | Same call; `fixed` / `failed` are terminal, Postgres holds the rule | ✔ |
| Escalate if unresolved after X days | Daily sweep on two clocks: stalled and overdue. Records the escalation on the ticket, badges it on the Repairs tab, notifies, and mails the escalation list | ✔ **built 2026-09-19** |
| *Nothing leaves silently* | Every stage change, every sign-off and every escalation reports; plus a daily open-job digest per organisation | ✔ **built 2026-09-19** for the ticket we have |

Two facts that still qualify the last two rows:

- **Mail is unconfigured in production.** `sendMail` returns
  `{ sent: false, reason: 'unconfigured' }` on the box today, so the durable
  feed item is the only channel that reaches anybody. Every event in §4 now
  writes one; the two that also mail (an unsuccessful sign-off, and an
  escalation) will start mailing the day the keys land, with no change to the
  code.
- **An automatic stage change writes no history.** `effective-stage.ts` derives
  `spare_outsourced → fixing` from the calendar on read. It is the right call
  for display and it means the transition has no event, no actor and no
  notification. Deriving a state is fine; deriving it *silently* is what this
  document is against.

---

## 6 · The delta, in the order it should be built

**Built on 2026-09-19: items 2, 3 and 4.** The reporting seam is
`src/modules/repairs/repairs.notify.ts`, the rule is
`repairs.escalation.ts` (pure, 15 tests in `tests/unit/repair-escalation.test.ts`),
the pass that runs it daily is `repairs.sweep.ts`, scheduled on the maintenance
queue at `REPAIR_ESCALATION_CRON`. The Repairs tab badges an escalated job and
says why. **Items 1, 5, 6 and 7 are not built** — each needs a migration, and
each is listed below in the order it should be taken.

1. **A ticket that exists before the technician arrives.** Open a row from
   probe health and from an ops report, both as `reported`. Without this, steps
   2–5 have nowhere to live and the escalation clock has nothing to run on.
2. **Report every transition.** One notification path at the point the stage is
   written, so no future caller can move a ticket without telling anybody.
   (Cheapest, largest single win against §4.)
3. **Escalation sweep.** A daily repeatable job beside the retention sweeps:
   stalled and overdue, each recorded on the ticket and notified.
4. **The daily open-ticket digest**, which is the only report that fires when
   nothing has happened.
5. **Split the spare states** (`spare_requested` / `spare_on_site` /
   `spare_ordered` / `spare_provided`) with reference, supplier and promised
   date, and give Stores a role and an action.
6. **Assignment and the access gate**, with reasons and durations, so the
   deployment delay the walkthrough names is measurable.
7. **`void`, and `precededBy`** for recurrence.

Items 2, 3 and 4 — now built — make the closing sentence true for the ticket we
already have: nothing changes a ticket without reporting it, and a ticket that
changes nothing is chased anyway. Items 1, 5 and 6 are what make the SEQUENCE
match the walkthrough: until they exist, steps 2 to 5 of the process (report,
investigate, assign, check security) all collapse into the single moment a
technician files a report, and the delay the walkthrough warns about — an
unavailable team or a missing vehicle — is still invisible. Item 7 stops the
counts from lying.

---

## 7 · Decisions needed from the business

1. **X.** Shipped as `REPAIR_ESCALATE_STALE_DAYS=3`,
   `REPAIR_ESCALATE_OVERDUE_DAYS=2` and `REPAIR_ESCALATE_REPEAT_DAYS=3`,
   settable in env without a deploy. Confirm the numbers or give others; the
   defaults are this document's proposal, not the business's answer.
2. **Who is escalated to.** "Beyond this product's owners" needs addresses.
   `REPAIR_ESCALATION_EMAILS` now exists and falls back to
   `REPAIR_NOTIFY_EMAILS` while it is empty — so escalation mail currently goes
   to the same desk as everything else. One line of env fixes it.
3. **Stores as a role.** Who may record "provided", and is it one team across
   all sites or one per site?
4. **The security gate's owner.** Who records that a deployment is blocked, and
   is "no vehicle" the same queue as "no escort"?
5. **Mail.** The MAILTRAP keys are still not on the box. Until they are, every
   external notification in §4 is a feed item only — the loop closes inside the
   app and not in anybody's inbox.
