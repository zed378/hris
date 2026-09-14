# 14 — UX Acceptance Criteria

What a screen change must satisfy before its task card is marked done. `../PLAN/21-ACCEPTANCE-CRITERIA.md` §6 carries the minimum; this is the full list. Each criterion names how it is verified and which document defines it.

A change that touches only a backend endpoint still owns the refused and error states of the pages that call it.

---

## 1. Every Screen Change

| # | Criterion | Verified by | Defined in |
|---|---|---|---|
| U1 | Works at 360 px with no horizontal page scroll; tables scroll inside `overflow-x-auto` | Browser at 360 px | `09` §4 |
| U2 | Works at 1280 px, in light and dark | Browser | `05` §1 |
| U3 | Loading, empty, error, refused (`402`/`403`) states designed; offline on pocket pages | Force each state (DevTools offline; a user without the permission; an unsubscribed tenant) | `11` |
| U4 | No `0` rendered where the truth is "no data" | Review against the API response | `00` principle 1 |
| U5 | Every action reachable and operable by keyboard; focus visible | Keyboard-only pass | `10` §4 |
| U6 | Async outcomes announced (`role="status"` / `role="alert"`) | Screen reader or DOM inspection | `10` A-5 |
| U7 | Unique document title and one `<h1>` | DOM inspection | `10` A-3 |
| U8 | Every input labelled; server field errors shown beside fields | Submit invalid data | `12` |
| U9 | Copy is Indonesian, uses the vocabulary table, no system words; no server `message` rendered | Review; the `PF-20` test | `13` |
| U10 | Money, dates, and times use `id-ID` formatting | Review | `13` §6 |
| U11 | Every visible control has a backend refusal when the user lacks permission (P9) | Call the endpoint without the permission | `00` principle 2 |
| U12 | A new page has a menu entry in the seed with a permission no weaker than its API's, or a documented other entry point | `menu-coverage.test.ts`; review | `03` §4 |
| U13 | No page imports server packages | `frontend-boundary.test.ts` | `../PLAN/16` §2 |
| U14 | Destructive actions confirm with the object and consequence | Review | `08` §5 |
| U15 | PII masked unless the viewer holds `employee.pii.unmask` | Log in as a user without it | `12` §5 |

## 2. Pocket Pages Additionally

(`/attendance/punch`, `/attendance/me`, `/attendance/consent`, `/leave/me`, `/payroll/me`, and `/leave/approvals` on a phone)

| # | Criterion | Verified by |
|---|---|---|
| M1 | Reachable from every other pocket page without the browser's back button | Navigate on a phone-width viewport — **fails today (`09` §2)** |
| M2 | Primary action full-width and ≥ 44 px tall below `sm` | Measure |
| M3 | Usable on a throttled "Slow 4G" profile with a mid-range CPU | DevTools throttling |
| M4 | Nothing sensitive cached on the device | `service-worker.test.ts`; inspect Cache Storage after use |
| M5 | Tested once on a real Android device, and once on a real iPhone before a release | Record in `MEMORY/records/` |

## 3. Attendance Evidence Screens Additionally

| # | Criterion | Verified by |
|---|---|---|
| E1 | A flagged punch never shows a success colour | Create a flagged punch |
| E2 | Each flag shown in words, the same words to the employee and to HR | Compare `/attendance/me` and `/attendance/review` |
| E3 | No coordinates or map on any team-level view | Inspect the live dashboard and its stream |
| E4 | Location is never requested without consent; refusing is not penalised in the copy | Withdraw consent and punch |
| E5 | HR opening a photo is logged | `photo_access_logs` row |

## 4. Release-Level UX Gates

Checked before Gate A pilots (`../PLAN/21-ACCEPTANCE-CRITERIA.md` §2).

| # | Criterion | State on 2026-09-13 |
|---|---|---|
| R1 | Mobile navigation exists (`09` §3) | **Not met** |
| R2 | Refused state renders on every page (`11` §5) | **Not met** |
| R3 | Lighthouse mobile: Performance ≥ 90, PWA 100, Accessibility ≥ 90 | **Not run** |
| R4 | Accessibility gaps A-1 to A-7 closed (`10` §3) | **Not met** |
| R5 | First-run setup guidance on the empty home dashboard (`11` §3) | **Not met** |
| R6 | A pilot HR administrator imports ≥ 100 employees from their own file unaided in < 30 minutes | **Not run** — this *is* Gate A |
| R7 | Five employees complete a punch on their own phones without help | **Not run** |
| R8 | No English reaches the screen: backend English, frontend Indonesian (ADR-030) | **Decided 2026-09-14; not yet applied** (`P6-24`, `PF-20`) |

## 5. Recording

The task's record in `MEMORY/records/` states, for each criterion touched: pass, fail with reason, or not applicable with reason. "Looked fine" is not a result.
