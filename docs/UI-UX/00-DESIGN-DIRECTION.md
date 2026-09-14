# 00 — Design Direction

The stance every screen in this product takes. Written 2026-09-13 against 32 built pages; where a rule below is not yet true of the code, the gap is named.

The rest of `UI-UX/` elaborates this document. When two of them disagree, this one wins.

---

## The Product in One Sentence

An HR system that an Indonesian SME's HR person picks **instead of their Excel workbook**, and that an employee on a mid-range Android phone on a mobile network can clock in with **in under ten seconds**.

Both halves are the design brief. The first is why the grid, the import pipeline, and `.xlsx` export exist (R6). The second is why the punch screen is the most carefully built screen in the product.

## Two Products Sharing One Codebase

| | Desk product | Pocket product |
|---|---|---|
| Who | HR administrators, owners, department heads | Every employee, including field and shift workers |
| Device | Laptop, often a small one, often shared | Phone, often mid-range Android, sometimes shared |
| Session | Hours, all day | Seconds, twice a day |
| Network | Office Wi-Fi | Mobile data, patchy, sometimes none |
| Core screens | Employees, grid, import, records, review queue, payroll runs, settings | Punch, my attendance, my leave, my payslip |
| Density | High — tables, filters, bulk actions | Low — one task, one big button |
| Tolerance for friction | Moderate, if it saves a day at month end | **Near zero** at 07:55 |

A screen belongs to one of these. Designing a screen for both produces a table nobody can read on a phone and a punch button nobody can find on a desktop.

## Principles

### 1. Honest over reassuring

The system never claims more than it knows.

- A punch that could not be verified says so, and says why — never a green tick that hides a flag.
- An offline punch says **"saved on this device, not yet sent"** until the server has it (`../PLAN/11-PWA-Frontend.md` §6.2).
- A figure the user may not see, or a module the tenant does not subscribe to, shows as **absent** — never as `0`. A zero reads as a fact.
- The live dashboard says when it has fallen back to polling.

### 2. The frontend hides; the backend refuses (P9)

Menus, buttons, and pages are hidden when the user lacks permission — for **convenience**, never for security. Every hidden control has a gateway refusal behind it. Design for the refusal too: a user can still reach a URL directly, and must see a clear `402` or `403` state, not a broken page (`11-EMPTY-LOADING-ERROR-STATES.md`).

### 3. Excel is the competitor, so respect Excel habits

HR staff think in rows, copy-paste, and filters. The product offers a grid with clipboard support (AG Grid, `/employees/grid`), import from their own spreadsheet with per-row errors they can fix and re-upload, and export to `.xlsx` that opens and matches row for row. Never force a form-per-record where a grid would do.

### 4. Evidence is a claim, not a verdict

Attendance screens present trust flags as **reasons for a human to look**, not accusations. The employee sees why their punch was flagged; HR sees the evidence and decides (P14). Language on these screens is neutral: "perlu ditinjau", not "curang".

### 5. Privacy is visible

Location is asked for only at the moment of a punch, with an explanation first (`../PLAN/10-Geolocation-Photo-Attendance.md` §2.3). The live dashboard has no map. Masked PII stays masked until someone with permission deliberately reveals it. Consent can be withdrawn from a screen the employee can find.

### 6. Indonesian, plainly

The interface is Indonesian (`lang="id"`), written the way an HR officer speaks, not the way a regulation is written. `13-LANGUAGE-AND-COPY.md`.

### 7. Nothing decorative

No illustrations, no animation that delays a task, no dashboard widgets that exist to fill space. The brand colour marks the primary action and the current location — nothing else.

## Current State Against These Principles

| Principle | State |
|---|---|
| 1. Honest | Largely met: offline status, flag reasons, `null`-not-zero, polling fallback notice |
| 2. Hide and refuse | Refusal met everywhere; **no page renders a designed state for an API `402` or `403`** — the refusal shows as the page's generic error line. A locked-module page (`/modules/[code]`) exists, but nothing in the app links to it |
| 3. Excel habits | Met: grid, import with per-row errors, export |
| 4. Evidence as claim | Met in the review queue and my-attendance |
| 5. Privacy visible | Met: consent page, no coordinates on the live dashboard |
| 6. Indonesian | Met in page copy; **not met for errors** — pages show the server's `message`, which is English by decision (ADR-030). Fixed by the frontend catalogue (`PF-20`) |
| 7. Nothing decorative | Met |
| **Pocket product on a phone** | **Not met: the sidebar is hidden below 768 px and nothing replaces it.** The home dashboard's cards link onward to some pages (punch, my leave, my payslip, approvals), but no page links back home, and `/attendance/me`, consent, and settings have no path at all — `09-RESPONSIVE-AND-MOBILE.md` |
| Accessibility | **Thin** — `10-ACCESSIBILITY.md` |
