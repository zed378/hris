# 13 — Implementation Status

This document records **what has actually been built**, what diverged from the
plan, and what is still open. It complements document `12` (the roadmap)
without replacing it: `12` states intent, this one states the situation.

Why it exists separately: a checklist inside a roadmap tends to get ticked
because "the feature is there", whereas what decides release readiness is
whether the feature is **proven to work on the real path**. What is recorded
here therefore always comes with how it was proven.

Last updated: 28 August 2026.

---

## 1. Summary

| Phase | Scope | Status |
|-------|-------|--------|
| P0 | Foundation: RLS, authentication, IAM, the outbox, additive migrations | Done |
| P1 | Multi-tenancy, modules, subscriptions, the two planes (tenant/admin) | Done |
| P2 | Employees, Excel import/export, PII, contracts, the grid, documents | Done |
| P3 | Attendance, PWA, evidence, trust, consent, the live dashboard | Done |
| P4 | Leave | Done |
| P5 | Payroll | **The framework is done; tax and BPJS calculation is locked behind Gate C** |
| P6 | Commercialisation | **Everything except billing (needs a payment gateway account)** |
| P7 | Observability, production readiness | Partial — health probes, backups, and structured logging are done |

Gate A (three pilots importing unaided) and Gate B (one paying tenant) are
**untested** — both demand real users, not code.

---

## 2. Divergences from the plan

A divergence is recorded together with its reason. One that is not recorded
reads as an oversight to anyone comparing the plan and the code side by side.

### 2.1 Tenant timezone — an ADDITION, present in no plan

Documents `02` and `10` both fail to mention timezones. The implementation
computed every day boundary in UTC, and for WIB (UTC+7) that means **every
punch between 06:00 and 10:59 in the morning was recorded on yesterday's
date** — the arrival window of almost the entire Indonesian workforce.

The consequences chain: every working day had only a clock-out punch, every day
counted as `ABSENT`, and every salary deduction that followed was wrong. Not one
error appeared.

The same bug affected schedule comparison: a `startMinute` of 480 translated to
08:00 **UTC** = 15:00 WIB, so nobody was ever recorded as late.

The `tenant.tenants.timezone` column (an IANA name, defaulting to
`Asia/Jakarta`) was added through an additive migration, and every working-day
boundary is now computed in the tenant's zone.

> **The consequence for the plan:** payroll (P5) computes from `attendance_days`.
> This bug will reappear as a salary discrepancy if P5 is built on data computed
> before this fix.

### 2.2 AG Grid 36, not 33

Document `01` §669 names AG Grid Community 33.x. What is installed is 36.1 — the
latest stable version at implementation time. The difference that matters: since
33, modules have to be registered explicitly (`ModuleRegistry.registerModules`),
and without that the grid is empty **with not one error in the console**.

### 2.3 Real time: SSE + LISTEN/NOTIFY, not Socket.IO + Redis

Already decided in document `12` §3 and implemented as written. What needs
recording as an operational limit: the `LISTEN` channel is **per tenant**,
because `LISTEN`/`NOTIFY` sits outside RLS's reach — one shared channel would
send every tenant's attendance activity to every listening process.

Each stream holds one PostgreSQL connection; the limit is 32 streams per
process. Past that, the dashboard falls back to 20-second polling, and that is
stated on screen.

### 2.4 Leave: single-step approval, a tiered schema

Document `12` speaks of a "tiered approval flow". What was built is a single
step — the approver is chosen by the requester, and their decision is final.

The `leave_approvals` table is already tiered in shape (`step_order`, one row
per step), so adding a second step later demands no structural migration. What
is missing is only the rule for who the next approver is — and that rule differs
at every company, so guessing it now means building something the first customer
to use it will tear out.

### 2.5 Payroll: the framework is built, the tax rules are not

Document `12` sets Gate C as a hard precondition before the first line of P5 is
written. What is built here is the part that **demands no interpretation of
regulation**, and the separation is maintained deliberately:

**Built** — an allowlisted formula parser with no `eval`, configurable salary
components, period-based salary structures (P13), the run cycle with
idempotency, payslips with a per-line calculation trace, and date-versioned
`statutory_configs` as the place the rates will eventually live.

**NOT built** — PPh21, PTKP, BPJS, proration, and overtime per Kepmenaker. All
of it demands a payroll expert and 30 real payslips as test cases. Writing it
from one's own reading of the regulations produces numbers that look plausible
and are wrong, and miscalculating an employee's tax is a legal liability borne
by the customer.

Once Gate C opens, PPh21 and BPJS enter as `DEDUCTION`-type components that read
`statutory_configs` — with no change to the calculation engine.

The Payroll Run screen states this limitation at the very top, not in a
footnote. HR who believe the tax is already computed will pay out salaries with
too little withheld.

### 2.6 Attendance machine import: generic, not per vendor

Per the decision in document `12` ("a native connector gets built when a
customer pays for that"). What was built is generic column recognition with
aliases, proven against three real formats: ZKTeco (`Date/Time` +
`C/In`/`C/Out`), an Indonesian format (`dd/mm/yyyy` + separate time columns), and
an export with no status column.

An unavoidable decision worth knowing: when the machine does not state the punch
type, **the first punch of a day is treated as a clock-in and the rest as
clock-outs** — not alternating. Alternating looks cleverer and is more fragile:
one finger placement that fails to read would flip the rest of that day.

---

## 3. What is proven, and how

What is listed here has been run end to end against a running system, not merely
passed a unit test.

| Claim | Evidence |
|-------|----------|
| A punch outside the geofence is still recorded and flagged | Score 35, `review=NEEDS_REVIEW`, the row is stored |
| EXIF is stripped from every photo | A test file containing `GPSLatitude` was uploaded; the stored file does not contain it, and the JFIF stays intact |
| An expired photo is deleted, its attendance record intact | The retention job: `deleted=1`, the file is gone, 9 attendance rows remain |
| A failed photo deletion does NOT delete its reference | A directory with the same name → `EPERM` → `failed=1`, the DB reference survives, and the next round completes it |
| Offline punches do not duplicate | The same `dedupeKey` resent → HTTP 200, one row |
| Attendance machine import is idempotent | The same file imported twice → `insertedRows=0, duplicateRows=4` |
| Working-day boundaries are correct in WIB and WIT | 06:00–11:00 WIB all fall on the right date; 01:30 WIT still belongs to the previous working day |
| Withdrawing consent takes effect on the server | Coordinates sent by the client → `latitude=NULL` stored |
| Withdrawing consent does not penalise | Penalty 0, `review=ACCEPTED` — consent given out of fear is not valid consent under the Personal Data Protection Act |
| HR access to photos and documents is logged (PR6) | The owner opens it → 0 records; HR opens it → 1 record |
| The live dashboard payload carries no coordinates (PR8) | Fields sent: id, employeeId, type, source, punchedAt, workDate, trustScore, review, workSiteId |
| The live dashboard is under 2 seconds | Measured at 305 ms from punch to arrival in the stream |
| A dangerous file named `.pdf` is refused | The type is determined from the magic bytes of its contents, not from the name or the `content-type` |
| Documents are archived, not deleted | The file is gone, the row survives, the next open returns 410 |
| A closed period refuses a manual correction | HTTP 409 with an explicit message; no row is silently stored |
| **50 simultaneous leave approvals against a 2-day balance → exactly 1 succeeds** | Measured: 1 success, 49 conflicts at 409. The Phase 4 DoD |
| A leave balance is never negative | A GENERATED column + `chk_no_negative_balance`; the final balance is 0, not −2 |
| Every balance movement has a ledger row | GRANT / HOLD / ADJUST / CONSUME / EXPIRE are all recorded |
| Overlapping leave is refused by the database | An inclusive `daterange` EXCLUDE constraint; HTTP 409 |
| Sick and maternity leave do not deduct the annual allowance | The annual balance does not move after a sick leave request |
| A day on leave is not counted absent | The daily recap goes ABSENT → LEAVE once the leave is approved |
| Year-end closing is idempotent | 10 days left, a carry-over cap of 6 → 6 carried, 4 forfeited; the second round does not duplicate |
| A salary formula cannot execute code | `eval`, `require`, `process`, `globalThis`, `__proto__` are all refused by the parser |
| A bad formula is refused when SAVED, not at run time | An unknown variable → HTTP 400 with the list of available ones |
| A component cycle is refused with its chain named | `A_KOMP → B_KOMP → A_KOMP` |
| Salary arithmetic is decimal, not float | `0.1 + 0.2` yields exactly `0.3` |
| A double run for the same period → exactly one | Two concurrent requests: 201 and 409 |
| Recalculating a run does not duplicate payslips | Payslips stay at 3, not 6 |
| Period-based salary structures are used correctly | The March run uses the 8 million salary, not the 10 million effective in July |
| An employee cannot open someone else's payslip | 403; HR gets 200 |
| An unapproved payslip shows no figures | `released=false` until the run is approved |
| **Disabling a module does not delete data** | 32 punches / 9 days / 3 shifts / 2 approvals — identical before, after, and after re-enabling. The Phase 6 DoD |
| A disabled module refuses its API with 402, not 500 | `MODULE_NOT_SUBSCRIBED` on all of its endpoints |
| A disabled module's menu disappears from the bootstrap | No `/attendance` or `/payroll` path |
| A module outside the plan cannot be enabled | 402 with a message about upgrading the plan |
| A core module cannot be disabled | 409 |
| A subscription change takes effect without a new login | `refresh()` reloads the bootstrap |
| Per-tenant quotas bite | 700 concurrent requests → 100 refused with 429 and a `retry-after` |
| Overload answers 503, not 500 | The same flood: 0 errors at 500, 372 replies at 503 with a `retry-after` |
| Query timeouts apply per role | `hrms_app` 15 s, `hrms_worker` 5 min, `hrms_platform` 30 s |
| Schema drift detection really detects | Both a `tenant_id` table without RLS and RLS without a policy were caught |
| Dashboard scope follows permissions, not a parameter | HR receives all three scopes; an employee gets only `own`, the rest `null` |
| A disabled module produces no fake numbers on the dashboard | `payrollRunsPendingApproval: null`, not `0` |
| Self-service registration without touching the team | A new tenant is created, can log in immediately, gets a 14-day trial, all modules active |
| A duplicate company code is refused | 409 with a message naming the code |
| **The Personal Data Protection Act portability export is complete** | 23 tables, 58 KB; ciphertext and password hashes are NOT included |
| The export includes modules that are NOT subscribed | Payroll data is included even with the module disabled — portability is not a function of subscription |
| **Restore from backup is tested, not merely written down** | A 272 KB backup restored into a fresh database: every row count identical, 47 RLS policies included, drift report 0 |
| Tenant isolation is intact after a restore | Tested as `hrms_app`: no context 0 rows, the demo context 3 employees / 32 punches, another tenant's context 0 |
| Liveness and readiness really differ | With PostgreSQL stopped: `/api/health` stays 200, `/api/ready` becomes 503 with a `retry-after` |
| Readiness recovers on its own | Once PostgreSQL is started: `ready` returns 200 within 40 ms |
| **Restore is measured at a realistic size** | 160 MB / 261,000 punches: backup 2 seconds, restore 5 seconds, 261,000 rows identical, drift 0 |
| File storage restore is tested | SHA-256 hashes identical, `storage_key` resolves to the right path |
| **Logs leak neither PII nor tokens** | An error carrying a national ID, a bank account, a password, and a Bearer token: none got through; scope, correlationId, tenantId, and the error code stay readable |
| Structured logging runs in the real process | The worker emits JSON with `ts`/`level`/`scope` |
| **The correlation trail is intact across processes** | `x-correlation-id` from HTTP → the `outbox.correlation_id` column → the worker log in a different process, the same value |
| Scheduled backups run without a Docker socket | A compose service produces a 62-table dump over the network; restored with RLS drift 0 |
| The service worker does not touch sensitive paths | The real `sw.js` run inside a VM: the API, `/admin`, credential pages, and requests carrying `Authorization` are all passed through |
| The service worker test is proven to catch regressions | Mutation testing: guard removed → the test fails; restored → it passes |

---

## 4. Bugs found through end-to-end testing

Recorded because the pattern repeats and is worth knowing before the next phase:
**every single one of these failed silently.** Not one produced an error, and all
of them would have reached production without end-to-end testing.

1. **Working-day boundaries computed in UTC** — §2.1 above. The worst of them.
2. **The photo storage path was relative to the process working directory** —
   `apps/web` wrote in one place and the retention job looked in another.
   Combined with number 3, the 90-day retention promise was void with not one
   error.
3. **`deletePhoto` swallowed every error** — a missing file was reported as
   successfully deleted.
4. **An event topic was published as a string literal** —
   `attendance.punch.flagged` was absent from the `EventTopic` catalogue, its
   queue was never created, and every flagged punch died after ten attempts. Its
   type is now `EventTopic`, so a literal outside the catalogue does not compile.
5. **Topics with no consumer** — two topics piled up in `created` forever. Now
   `Record<EventTopic, Consumer>` forces one decision per topic at compile time.
6. **Attendance machine punches were scored by phone standards** — no location
   and no photo means a score of 50, below the threshold, so EVERY machine punch
   entered the review queue. For a tenant using a machine, that queue contains
   all of their attendance.
7. **An export link could not carry a token** — `<a href="/api/…">` is followed
   by the browser without an `Authorization` header, so the Excel export and the
   template download were always 401. The export feature could never be used
   from the UI.
8. **A masked PII value could be saved as the real value** — the grid locked its
   column, but the same write path is used by imports, bulk updates, and the API
   directly. Its guard moved to the write boundary (P9).
9. **A manual HR entry entered HR's own review queue** — and raised the flagged
   ratio, the very metric used to detect a badly set threshold.
10. **`if()` in a salary formula evaluated both branches** — the built-in formula
    found it itself: `if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)`
    was written precisely to guard against division by zero, and full evaluation
    meant the guard never worked. The whole run failed for every employee without
    an attendance recap yet. The original reasoning — "a salary formula has no
    side effects" — missed that division by zero is an error, not a side effect.
11. **The formula variable guard could be bypassed through the prototype chain** —
    `scope['__proto__']` returns `Object.prototype`, not `undefined`, so the
    unknown-variable check let it through. Fixed with `Object.hasOwn`. A guard
    that can be bypassed for one name cannot be trusted for another.
12. **Downgrading a plan did not revoke module access** — entitlement only read
    `TenantModule.status`, without intersecting it with the modules included in
    the plan. A tenant dropping from Basic to Starter kept an ENABLED `payroll`
    row from the previous subscription and went on using payroll without paying
    for it. No error appeared — the only thing that changed was their invoice.
    Fixed: entitlement is now the intersection of plan and status.
13. **A request flood produced 500s, not 503s** — 700 concurrent requests
    exhausted the transaction pool, and Prisma threw "Unable to start a
    transaction in the given time", which surfaced as a 500. Wrong in two ways:
    clients and proxies do not retry a 500 (they retry a 503 with a
    `retry-after`), and error monitoring recorded it as a bug when the system was
    working exactly as designed — it was full. A per-minute quota limits RATE,
    not CONCURRENCY, and what exhausted the pool was concurrency.
14. **The SSE stream used the database owner's connection** — `DATABASE_URL`
    connects as `hrms_owner`, the only role that can bypass RLS and is not bound
    by `statement_timeout`. Every open live dashboard held a connection with full
    privileges and no time limit, for work that only needs to listen on one
    channel.
15. **The portability export skipped unsubscribed modules** — wrong in precisely
    the case that matters most: a customer who downgrades and then wants to move
    systems does not receive their payroll data. The data is still there — a
    disabled module deletes nothing — but they cannot retrieve it. That is
    lock-in dressed as compliance, and it contradicts the very right the export
    exists to fulfil.
16. **A `BigInt` brought down the entire export** — `JSON.stringify` throws "Do
    not know how to serialize a BigInt", and that error failed the WHOLE file,
    not one column of it. What used it were the keys on the leave balance ledger
    and the access trail — precisely the things that most needed to be carried
    along.
17. **The container healthcheck pointed at a client page** — `HEALTHCHECK`
    called `/`, which renders a React page and returns 200 even with the database
    down. The container reported healthy while the application could serve
    nothing, and the orchestrator had no reason to move traffic away.
18. **The manifest coverage checker was blind to `export function GET()`** — its
    discovery regex only recognised `export const GET =`. A route written in
    `function` form is a perfectly valid Next.js handler, but was invisible to
    the P7 test: it skipped manifest registration, skipped the `defineRoute`
    wrapper check, and worked perfectly when tested by hand — while checking no
    permission at all. A hole in the guard itself.
19. **The `LEAVE` status was never produced** — the value existed in the type
    from the start, but no code path produced it. An employee whose leave their
    manager had approved was still recorded `ABSENT`, and then docked pay as
    absent without notice. The same class as number 4: an enum value declared but
    never produced by anyone.
20. **The offline punch queue did not store its owner** — the queue DELIBERATELY
    survives a logout (it belongs to the device, not the session; clearing it
    would throw away the punches of whoever just logged out). That decision
    remains right. What was wrong was its consequence: the server derived the
    `employeeId` from the **session**, not from the punch contents. On a shared
    device — a three-shift warehouse phone, a security post computer — A punches
    while the network is down, A logs out, B logs in, the sync runs, and **A's
    punch is recorded as B's attendance**. A's attendance vanishes; B receives an
    attendance they did not perform; both only become visible when the payslips
    are issued. `QueuedPunch.ownerUserId` is now mandatory and `flushQueue` takes
    the id of the user currently logged in. Someone else's punch is **left
    behind**, not discarded — its owner may log in again on the same device — and
    counted separately (`otherUsers`) so it does not appear as "3 unsent" that
    will never be sent for whoever is looking at it. Tested in
    `apps/web/test/offline-queue.test.ts`, including a test that another person's
    punch is NOT deleted and is sent as soon as its owner logs in.
21. **The leave accrual methods were never produced by anyone** — the same class
    as numbers 4 and 19, and the third occurrence. `AccrualMethod` has had five
    values since the leave module's first migration and HR can choose all five on
    the leave type screen, but `ensureBalance` granted the full `defaultQuotaDays`
    **whatever the method**. A tenant choosing `MONTHLY_ACCRUAL`: an employee
    joining on 10 March immediately received 12 days, could take all of them in
    April and resign in May. A tenant choosing `ANNIVERSARY`: an allowance that
    under Article 79(3) of the Labour Law only arises after 12 continuous months
    of service existed from 1 January for someone who had worked a month. Neither
    produced an error; the number was simply wrong, and wrong in the employee's
    favour, so nobody would ever report it.
22. **The fix for number 21 nearly installed a worse bug** — recorded because its
    shape is more valuable than the bug itself. The first version of
    `entitlementAsOf` returned zero when evaluated before the period's year
    began, for **every** method. But `runCarryOver` creates the NEXT year's rows,
    and if the year-end close runs on 31 December its evaluation falls before the
    new period starts: the whole company would begin the year with a zero
    allowance, and because `ANNUAL_GRANT` does not grow over time, no path would
    ever fix it afterwards. Found while tracing its interaction with the year-end
    close, not by a test. It is now guarded by a regression test verified through
    mutation.
23. **The `expires_at` column was built for documents that could not be entered** —
    a shape of silent failure not previously seen in this list. The list of
    document kinds allowed by the CHECK constraint contained KTP, KK, NPWP,
    IJAZAH, KONTRAK, SERTIFIKAT, and LAINNYA. Of those seven, only KONTRAK and
    SERTIFIKAT have an expiry date — and KONTRAK already has a reminder path of
    its own. **KITAS, IMTA, and SIM were not on that list**, so a foreign
    worker's permit could only be stored as 'LAINNYA', and as 'LAINNYA' it is
    indistinguishable from any photocopy. The expiry feature was built for a case
    that could not be represented. Found only because an e2e test tried to create
    a real KITAS document.
24. **The document kind list was hand-written in three places** — the CHECK
    constraint, a constant in core, and an array on the upload page. All three
    already differed. A difference like that produces no error at compile time or
    deploy time; it appears as an HTTP 500 on someone's first upload. Now one
    constant in `@hrms/contracts` (client-safe, no Prisma) and one constraint,
    with a test comparing both against the **PostgreSQL catalogue** — not against
    a list rewritten in the test file. Verified through mutation: changing one
    value fails 2 tests.
25. **A large payroll run would never finish, however many times it was retried** —
    and the recovery code had been there from the start, it simply never had a
    chance to be useful. The calculation ran inside a single HTTP request
    transaction. Prisma's interactive transactions are capped at five seconds by
    default; the `hrms_app` role is capped by a fifteen-second
    `statement_timeout`. A thousand-employee run passed both, its transaction was
    rolled back, and **every payslip already computed was lost** — so the next
    attempt found zero payslips, started from the beginning, and failed at the
    same second. A comment in the code promised "kill the worker mid-calculation
    → it continues with no duplicate payslip", and the code did skip existing
    payslips; what did not exist was a payslip that had ever been committed.
    Measured directly: the old path **failed at second 5.2 with 0 payslips
    surviving**. The new path completes 1,003 employees in **8.5 seconds** across
    21 chunks, each committed; re-running it produces **0 new payslips in 13 ms**.
26. **National ID, tax ID, and bank account numbers were stored as plain text in
    the import staging table** — which voided the entire PII encryption effort
    for the most-used onboarding path. `import_rows.raw` and `.parsed` stored the
    file's contents as they were, and an employee import file contains all three
    columns. One 500-employee import left 500 national IDs as plain text inside
    JSON — **in the same database** that encrypts the national ID column in the
    table next to it with AES-256-GCM, indexes it with an HMAC, and audits every
    unmasking. Import is the primary onboarding path (Gate A: three pilots
    importing ≥100 employees unaided), so this hole applied to nearly all of the
    data that would ever arrive. `preparePii` is now called when the **preview is
    created**, not at commit time; plain text never enters.
27. **No path deleted an import preview row** — the `DISCARDED` status had been
    in the enum since the first migration with no producer, the same pattern as
    numbers 4, 19, 21, and 23. A preview uploaded and then abandoned survived
    forever, and HR trying their file format five times before it worked left
    five copies of their personnel data. Now: rows are deleted at commit (the
    job's summary stays for the audit trail), and previews older than 7 days are
    discarded by a daily job — which finally gives `DISCARDED` a producer.
28. **The fix for number 26 still leaked through UNRECOGNISED columns** — found
    by an e2e test rather than by reasoning, and subtle in shape. The first
    version stored every cell as it was and then masked the **recognised** PII
    columns. But `"NIK"` alone is **deliberately not a recognised alias**: the
    alias list excludes it with a comment reading *"guessing wrong means storing
    a national identity number in an unencrypted column"*. That caution was
    right — and then undone by a raw cell store that was not thought through
    alongside it, so a file headed "NIK" left complete ID card numbers behind.
    The same applied to a tenant's own custom columns: "Nama Ibu Kandung",
    "Golongan Darah", "Nomor BPJS" were all stored intact without anyone asking.
    `raw` is now an object of recognised columns only; anything unrecognised is
    not stored at all.

    The honest note that accompanies it: **no path reads `raw` yet.** Its stated
    reason — "so an error message can point at exactly what the user typed" — is
    a plan, not a feature. A column nobody reads but that holds personal data is
    pure liability, and that is stated in the code rather than left looking like
    a feature.
29. **A tenant could not enter national holidays at all** — the table has existed
    since the attendance module was built and is read by two modules, but its
    only populator was the seed: **five hand-written dates in 2026**, with not one
    Islamic holiday, Nyepi, Waisak, or Lunar New Year. 2027 had none at all. The
    dates are set each year by a joint ministerial decree and some follow the
    Hijri calendar, so no code can compute them in advance — they have to be
    enterable by the tenant, and there was no way. The consequences were
    compounding and all silent: leave requested across Eid **deducted balance**
    for days the office was closed, and the attendance recap before payroll
    recorded **everyone as ABSENT** on every holiday — a number the salary formula
    used directly to dock wages. There is now
    `GET`/`POST`/`DELETE /api/attendance/holidays` and its screen.
30. **Weekends were recorded as ABSENT** — and this invalidates part of a claim I
    wrote myself in the previous number. `countWorkingDays` in the leave module
    assumed Monday–Friday; `calculateDay` in the attendance module **assumed
    nothing**, so without a schedule row every Saturday and Sunday became ABSENT.
    `buildSnapshot` computed `hariAlfa` from that status and the salary formula
    docked pay from that figure — weekends became salary deductions. Both modules
    now use the same assumption, and a schedule still wins where one exists.
31. **`holidays.is_joint_leave` was never read by anyone** — the column has
    existed from the start with a comment stating its purpose exactly: *"Joint
    leave deducts the annual leave allowance; a national holiday does not."* No
    code path read it. The consequence favoured employees and would therefore
    never have been reported: a company with four joint leave days gave **four
    extra paid days off per employee per year** beyond the 12-day allowance — for
    a hundred employees, four hundred working days missing from anyone's
    calculation. The basis is the joint ministerial decree, which establishes
    joint leave as a deduction from the annual leave allowance.

    The deduction is idempotent through a **ledger row**, not through a flag on
    the holiday table: a flag would be right only until someone added a new
    employee after the deduction had run. It also **never creates a negative
    balance** — an employee who has used their allowance still takes the day off
    because the office is closed, and the shortfall is reported so HR can decide,
    rather than forced until `chk_no_negative_balance` refuses it for the next
    person to request leave. Deleting the date, or downgrading it to an ordinary
    holiday, **returns** the deduction — the government does revise joint leave
    dates mid-year, and a correction that only works one way means someone's day
    off disappears without a trace.

    Verified e2e: the first deduction was 2 days for 2 employees with 1 shortfall
    recorded; the second deduction was **0 days**; a national holiday produced not
    one ledger row; attendance marked both dates `HOLIDAY` and an ordinary Sunday
    `DAY_OFF` (not `ABSENT`); cancelling returned exactly 2 days.
32. **A customer who stopped paying could not be deactivated** —
    `TenantStatus.SUSPENDED` and `CHURNED` have been checked from the start on
    login, token refresh, and password reset requests, all of it fail-closed and
    correct. What was missing was any path that **produces** those statuses. The
    entire subscription machinery worked — plans, entitlement, the 14-day trial,
    the per-module 402 — without the final switch that stops access when the bill
    goes unpaid. The same for a customer requesting termination: `CHURNED` was
    unreachable, so the request could only be served by deleting data — an
    irreversible act, and not the one that was asked for. There is now
    `POST /admin/api/tenants/status` with a mandatory reason.

    **The permission denial that appeared while testing it is the design working,
    not a bug.** `hrms_platform` only has SELECT on `tenant.tenants`; the control
    plane is deliberately almost incapable of writing anything into the tenant
    plane. So its rights were widened as little as possible — `UPDATE` on **four
    columns**, not on the table — so a superuser who is compromised later cannot
    rename a company or move its plan.

    One detail that was expensive to diagnose and is therefore recorded in its
    migration: `updated_at` has to be in the column list, because Prisma's
    `@updatedAt` writes it on **every** update. Without it PostgreSQL answers
    *"permission denied for **table** tenants"* — naming the table, not the
    missing column — so the denial looks like a forgotten table grant, and the
    next temptation is to grant full `UPDATE`.

    Verified: suspension writes `suspendedAt`, repeating the same status is
    refused with 409, reactivation **does not clear** `suspendedAt` (that history
    is needed in a billing dispute), and both transitions are recorded in the
    platform audit trail together with their reason. An attempt to delete that
    trail was refused — the table is append-only, for the platform role too.
33. **No path marked a payroll run as paid** — the `PAID` status and the
    `paid_at` column existed from the start, and **two read paths check them**
    (the dashboard and the payslip list both treat `APPROVED` and `PAID` as
    "released"). Nothing produced them. Approval and payment are two distinct
    events often days apart — a run approved on the 25th, the bank transfer
    executed on the 28th — and without that distinction the question "did last
    month's salary actually go out" has no answer inside the system. The person
    asking is the employee whose money has not arrived.
34. **A newly registered tenant owner could not add a single person** — three
    menu entries under "Settings" have appeared since the first seed and all led
    to pages that never existed: Users, Roles, Audit Trail. Their endpoints have
    been complete since Phase 1; only the screens were missing. This is the same
    class as `/attendance/shifts`, and the consequence is larger:

    - **Users** — an owner registers themselves, gets an owner account, and then
      stops. There is no way to invite their HR, give a manager the right to
      approve leave, or revoke the access of someone who has left. The entire IAM
      story — roles, per-user rights, the `DENY` that beats everything — could
      only be exercised through `curl`. **This blocks Gate A directly**: three
      pilots onboarding themselves cannot do so if their company is allowed only
      one account.
    - **Roles** — a role could only use the permissions the seed happened to
      grant. A company whose manager also handles payroll, or that does not want
      its HR unmasking national IDs, had no route at all.
    - **Audit Trail** — the trail has been written since Phase 1 on every path
      that changes data, its table is append-only, and UPDATE/DELETE are revoked
      even for the table owner. **There was no way whatsoever to read it** — no
      endpoint and no page. An audit trail that cannot be read is not half a
      feature; it is zero feature, because its entire use is answering "who
      changed this, when, and from what value" for someone without `psql` access.

    Verified against a real server: 5 roles with a catalogue of **49
    permissions**; an invitation produces a user with status `INVITED` plus an
    outbox event (their password is never set by anyone but them); the audit
    trail is readable with cursor pagination and correct actor names; staff
    trying to read it are refused with **403** (P9).

    The permission catalogue is sent together with the role list in one response,
    not separately: the window between two requests is a screen showing roles
    with no permissions at all, and that reads as "this role has no rights".
    Audit pagination is **cursor**-based, not offset-based — on a table every
    action appends to, an offset skips rows continuously.

    **A permanent guard was installed for the class, not only for the case.**
    `apps/web/test/menu-coverage.test.ts` reads the menu paths from the seed file
    and checks them against the file system — the menu is assembled from the
    database, so TypeScript cannot see its connection to a `page.tsx`, and four
    entries appeared for months leading to 404s. The same test checks that every
    permission code named by a menu or by `ROUTE_MANIFEST` actually exists in the
    catalogue: one wrong letter there refuses **everyone** with a 403, the tenant
    owner included, with a message blaming their role rather than the code. Both
    are verified through mutation.

    A third guard followed: `apps/web/test/api-call-coverage.test.ts` compares
    **every `api('/api/…')` call made from a screen** against the manifest. This
    is the quietest class of the three — a mistyped path produces a 404 that the
    screen's own error handling swallows, and what the user sees is a list that
    never fills. Its first sweep checked 73 calls and found not one orphan.

    Two false positives that appeared while writing it were fixed and recorded in
    the code, because both are lessons about tests of this kind: a capture
    pattern accepting all three quote types stops at a quote **inside** `${...}`,
    and an interpolation attached to a literal segment
    (`documents${archived ? '?a=1' : ''}`) must not be treated the same as an
    interpolation filling a whole segment. **A false positive is more dangerous
    than a false negative**: a test that accuses correct code gets switched off,
    taking all of its guarding with it.

### Three findings from walking the pilot flow

All three were found by doing what a customer actually does — register, invite,
configure, import, schedule, punch, request leave, run payroll, export — against
a real server, and **not one by a test.** All three block Gate A, and all three
failed without an error.

35. **A new tenant is born with no leave types and no salary components.**
    `provisionTenant` creates the tenant, its modules, roles, and owner. Leave
    types and salary components only existed on the demo tenant, through a seed
    that never runs for a real customer. The consequence: an active leave module
    with an **empty** dropdown — nobody could request leave at all — and a payroll
    module where **every payslip was zero rupiah**, computed correctly from
    nothing. Both are now created inside the same provisioning transaction, from
    constants in `@hrms/contracts` that are **shared with the seed** so they
    cannot diverge. The salary amounts are deliberately 0: the figure is the
    company's decision, and guessing it means somebody runs their first payroll
    on a number they never approved. The leave allowances, by contrast, carry
    figures, because those figures come from Articles 79 and 93 of the Labour Law.
36. **Imported employees have no accounts, and there was no bulk way to create
    them.** The user → employee mapping is a soft reference through email
    (PLAN/01 §4.2), and that design is right. What was missing was the bridge: HR
    imports 100 employees and **not one of them can log in**, punch in, request
    leave, or see their payslip. The only route was inviting them one at a time
    through a form asking for the email and name that were **already** in their
    employee row — 100 times, after a successful import. There is now
    `POST /api/users/from-employees`. Those who already have an account are
    skipped rather than failing the batch; those **without an email are named,
    with their employee number**, because "12 employees without an email" is not
    actionable while their names are.
37. **An employee who has never requested leave saw an EMPTY balance screen.**
    Balance rows are created when needed, and what needs them is a request — not a
    read. Empty does not read as "no movements yet"; it reads as **"I have no
    leave entitlement"**, and someone who concludes that will not request leave,
    and their allowance then expires at year end never having been used.
    `readBalances` now shows the types with no row yet along with the allowance
    that should already have accrued — computed by the same function
    `ensureBalance` uses when it eventually stores it, so what is seen now is
    exactly what will be stored later. The rows are **not created** on the read
    path: a GET that writes fails on a read replica and turns opening a page into
    an action that changes data.

**The chain now proven intact**, run against a real server from a freshly
registered tenant: register → invite HR → enter the holidays → create shifts →
import 4 rows (3 valid, 1 refused for a missing join date) → generate 93 schedule
rows for a six-day factory pattern → correct attendance manually → bulk-invite 3
employees → an employee accepts the invitation and **sets their own password** (a
used token is refused with 400) → log in → their account links to their employee
data through the email → request 3 working days of leave → the manager approves →
the employee's balance goes from 12 to 9 → payroll runs (202, the worker) → three
`.xlsx` exports downloaded → 11 kinds of action recorded in the audit trail.

---

## 5. What is still open

### Backups — their limits

The backup and restore procedure is **tested and documented**
([runbook §6](../ops/RUNBOOK.md)), closing a DoD item open since P0. Three limits
are worth knowing:

- **There is no PITR yet.** Maximum data loss = the interval between backups.
- **Photo and document files are backed up too**, as a separate archive with the
  same timestamp, and their restore is tested down to the hash.
- **Not tested above 160 MB.** The numbers are linear across the range tested,
  but extrapolation is not measurement.
- **Archiving tens of thousands of small files has not been measured** — `tar`
  over many small files behaves differently from `tar` over one large file.
- **Tested on a database of a few hundred kilobytes.** Restore time at
  production size has not been measured.

### Observability

- **Structured logging** through `@hrms/observability`: the level from
  `LOG_LEVEL`, a timestamp inside the JSON, a `correlationId`, and **redaction of
  sensitive keys**. 43 `console.*` sites were migrated; the CLI tools
  deliberately stay plain text because they are read by a person in a terminal,
  not collected by a machine.
- **The `LogFields` type makes `scope` mandatory.** Three log sites that had gone
  without a scope were caught at compile time, not when somebody searched an
  aggregator.
- **There are no metrics yet.** No Prometheus endpoint and no request counters;
  there are only logs. Added when someone actually collects them.
- **The request context is for LOGGING ONLY.** The tenant, as the basis of
  isolation, is still passed explicitly to `withTenant` — authorisation that
  reads implicit state can leak across requests when one `await` goes unawaited.
- **Correlation flows across processes** through `AsyncLocalStorage` at the
  request boundary, the `correlation_id` column on the outbox, and forwarding in
  the worker's consumers. An external `x-correlation-id` header is honoured, so
  the trail can be joined up with an upstream system.
- **There is no span-based tracing yet** (OpenTelemetry). What exists is a
  correlation id, not a span tree with per-layer durations. Added when someone
  actually collects them.

### Technical debt

- **Backfilling `work_date`** — `punch_logs` rows recorded before the timezone
  fix carry the wrong working date. There is no production yet, so no backfill
  has been run. **It must be run before the first release** if any data is kept.
- **The 12% flagged-ratio threshold is not calibrated** — calibration demands
  pilot data. Its largest cause is already gone: a tenant can now declare that a
  photo or location is genuinely not required, so their absence stops flooding
  the queue.
- **Document expiry reminders exist** (number 23), **their deletion does not —
  and that is deliberately deferred.** The period is a legal decision, not a
  technical one: Article 28(11) of the General Tax Provisions Law requires tax
  documents to be kept for 10 years, while the Personal Data Protection Act
  requires personal data not to be kept longer than necessary — and both demands
  apply to different files inside the same employee folder. Guessing one number
  and then deleting automatically is a way to destroy evidence that may be
  needed. What is needed first: a retention classification per document kind,
  agreed with the tenant's legal adviser.
- ~~**`employee_documents.employee_id` has no foreign key**~~ — **done**, and the
  obvious fix turned out to be the wrong one.

  The single-column key (`REFERENCES employees(id)`) was written, applied, and
  then **tested against a cross-tenant insert, which succeeded**: connected as
  `hrms_app` with `app.tenant_id` set to one tenant, a document was written
  pointing at an employee of another. **PostgreSQL performs referential integrity
  checks without row level security** — deliberately, because a key that saw only
  visible rows would report "no such row" for a row that exists, and that
  difference is a covert channel.

  So RLS and the foreign key each check something real and neither checked this.
  The resulting row is invisible from **both** tenants — filtered out of its
  owner's folder by `employee_id`, filtered out of the other's by RLS — while the
  file it points at sits in object storage holding someone's identity card.
  Invisible from both sides reads like containment and is really a leak nobody can
  find.

  Shipped instead: `FOREIGN KEY (tenant_id, employee_id) REFERENCES
  employees(tenant_id, id)`, which closes it at the database regardless of RLS,
  of role, and of what the application believes about itself. Re-run of the same
  insert now fails with `Key is not present in table "employees"`.

  `ON DELETE RESTRICT`, where `employee_contracts` uses `CASCADE`. A document row
  owns a file; cascading deletes the row and strands the file, which is the exact
  order photo retention and `cleanupOrphanAttachments` both reverse on purpose.
  A contract row owns no file, so cascading one strands nothing.

  With the relation known to Prisma, `scanDocumentReminders` no longer reads
  employees through a second query and joins them in a `Map`.
- **A migration that must run outside a transaction has no runner.** Found while
  writing the above: **Prisma wraps every migration in a transaction and offers
  no way to opt out** (7.9.1 — `CREATE INDEX CONCURRENTLY` fails with SQLSTATE
  25001). Two consequences, both previously believed otherwise:

  - `CREATE INDEX CONCURRENTLY` cannot be used at all, though `ops/scripts/lint-migrations.mjs`
    requires it and suggests a `-- prisma-no-transaction` marker **that Prisma
    does not implement** — it is borrowed from other migration tools. The rule has
    never fired because no migration has yet needed a concurrent index.
  - The `ADD CONSTRAINT ... NOT VALID` / `VALIDATE CONSTRAINT` split buys nothing
    inside one transaction: the exclusive lock from the first statement is held
    until commit, so the scan runs under it anyway.

  Harmless so far — every index built to date was on a table created in the same
  migration, and both tables in the foreign key above are small. It stops being
  harmless the first time an index or constraint is needed on `punch_logs` or
  `attendance_days`, which is risk R33 exactly. Needs a runner that executes
  statement-by-statement outside a transaction, or an explicit exception process.
- **`accessVersion` (`av`) is issued into every token and read by nothing.**
  `packages/core/src/auth/tokens.ts` mints it, `accessTokenClaimsSchema` validates
  it, and its comment describes the gateway comparing it against the recorded
  version and rejecting stale tokens — **no such comparison exists anywhere.**

  Currently harmless: access is resolved fresh from the database on every request,
  so the cache the version invalidates does not exist. It becomes load-bearing the
  moment a permission cache does — which is `PLAN/14` §5 option C, the mechanism
  that makes the auth split affordable. Must be implemented **before** the cache,
  not alongside it.
- **The rate limiter is per-process and silently multiplies by replica count.**
  `apps/web/src/lib/rate-limit.ts` keeps buckets in a local `Map`; the per-tenant
  quota in `define-route.ts` has the same shape. With one container it is correct.
  With two replicas it permits twice the configured rate, with no error and no log
  — the limit is simply not the number in the config. Blocks horizontal scaling,
  which is one of the stated reasons for `PLAN/14`.
- **The PII encryption key has never been rotated** — its cipher format is
  versioned (`v1.`), so rotation is possible without a large migration, but the
  procedure does not exist and has not been tested. It matters more since number
  26: all PII now genuinely exists only in encrypted form, so losing the key
  means losing the data — no longer merely losing one copy that happened to
  remain in the import staging table.
- ~~**`attendance_policies` does not exist**~~ — **done.** Four behaviours that
  determine attendance were constants inside the code: a review threshold of 60,
  a 90-day photo retention, and location and photo requirements applying to
  everyone. Document 10 §2.4 states the reason exactly: *"This decision belongs
  to the tenant, not to the system — a construction firm and a consultancy have
  different answers."*

  It also closes one of the technical debts recorded in this very document: a
  flagged ratio far above the 12% threshold **because the test punches had no
  photo**, not because anything was suspicious. A tenant who genuinely does not
  ask for photos would experience that every day — and HR whose review queue is
  full stop reviewing, which turns the trust score into theatre (PLAN/12 §11).

  Its default values are **exactly the same** as the constants they replaced: a
  tenant who never touches the settings screen behaves as they did before this
  table existed. A behaviour change arriving alongside a configuration feature is
  a change nobody asked for.

  Verified through the real `recordPunch` path:

  | Policy change | Measured effect |
  |---|---|
  | `requireLocation` true → false | `NO_LOCATION` 30 → **0**, score 20 → 50 |
  | `photoRetentionDays` 90 → 30 | photo expiry 2026-11-29 → **2026-09-30** |
  | `autoApproveThreshold` → 95 | a score of 50 now enters the review queue |
  | `onPermissionDenied` → BLOCK | the punch is refused, and the message names **what is missing** |

  The flag **still appears** even when its penalty is zero. Removing it would
  make "no location" indistinguishable from "inside the fence", and that is
  information lost with nobody asking for it.

  Retention is computed **when the photo is stored**, not when it is deleted —
  raising it does not extend the life of existing photos, and lowering it does
  not shorten them. A photo is subject to the promise in force when it was taken.

  ~~`FALLBACK_ONLY` is accepted but does not yet behave differently from
  `ALLOW_FLAGGED`~~ — **done.** See the entry below.
- **`FALLBACK_ONLY` now behaves differently from `ALLOW_FLAGGED`, and work sites
  finally have a screen.** Two halves of one hole.

  The policy could be selected, was stored, and passed the CHECK constraint while
  doing **nothing**, because it demands an office network list that no endpoint
  and no screen could write. And `attendance.work_sites` — read on every punch
  since Phase 3 — had `GET` and `POST` and **no page at all**, so a self-service
  tenant could not draw a geofence either. The permanent guard for a menu leading
  nowhere (`menu-coverage.test.ts`, number 34) cannot see this shape: a menu
  pointing at a missing page is visible from the seed, an endpoint nobody can
  reach is visible from nothing.

  What was added:

  | Piece | Where |
  |---|---|
  | `work_sites.ip_ranges INET[] NOT NULL DEFAULT '{}'` | `20260901090000_work_site_networks` — additive, rule M4 |
  | `checkOfficeNetwork()` — `<<=` containment, in SQL | `packages/core/src/attendance/office-network.ts` |
  | `PATCH /api/attendance/work-sites/[id]` — audited before/after | first way to edit a site at all |
  | `/attendance/sites` — geofence + network editor | menu `attendance.sites` |

  The containment test is **raw SQL on purpose**. `<<=` already knows about
  netmasks and both address families; a TypeScript reimplementation would be a
  second definition of "inside the network", certain to disagree with the first
  one day.

  Verified against the running server, all three paths:

  | Situation | Result |
  |---|---|
  | `FALLBACK_ONLY`, network configured, address **outside** it, no location/photo | **refused**, and the message names every remaining way to punch |
  | same, address **inside** it | **201**, `OFFICE_IP_VERIFIED` at penalty 0, score 80 |
  | `FALLBACK_ONLY`, **no** network configured | **201** — degrades to `ALLOW_FLAGGED` |

  That last row is deliberate fail-open, and it is the only fail-open in the
  policy. Refusing instead would lock out an entire company at 07:00 over a list
  they may not know exists. The degradation is **shown on the settings screen**
  through `officeNetworkConfigured`, because a policy that quietly does nothing is
  the exact bug this change exists to remove.

  A verified office network **removes the browser penalty; it never adds score**,
  and it does not rescue a punch that failed the geofence. It proves where the
  packets came from, not that anyone is in the building — a VPN satisfies it
  exactly. If it could rescue a geofence failure, anyone on the company VPN could
  punch from home unflagged and the whole fence layer would be optional.

  Two defects were caught by writing the tests afterwards, both of the silent
  kind this document keeps recording:

  - **The address validator accepted `203.0.113.7:54321`** — one colon, digits
    and dots only, so the "is it IPv6?" charset test waved it through. It would
    have reached `::inet`, and the **cast raises**: a strange proxy header would
    have failed the punch, the precise outcome the surrounding comment promised
    could not happen. Both hand-written validators are now `node:net`'s `isIP`.
  - **`PUT /api/attendance/policy` returned no `officeNetworkConfigured`** while
    the settings screen replaces its state from that response. Choosing
    `FALLBACK_ONLY` would have displayed the warning that says the setting does
    nothing at the instant it started doing something — the same silent lie, one
    layer up.

  The IPv4-mapped form (`::ffff:203.0.113.7`) is unwrapped before the comparison.
  Node reports it on a dual-stack listener, PostgreSQL treats it as a different
  address family from `203.0.113.0/24`, and `<<=` is false — an office network
  configured the obvious way would have matched **nobody, on the deployed server
  only**, while every local test with a literal IPv4 passed.
- **The punch dedupe key is now guarded at runtime**, not only by the type.
  `where: { dedupeKey: undefined }` in Prisma **ignores the condition** — it
  matches any row in that tenant, so a punch without a key was answered "already
  recorded" along with somebody else's trust score, and no new row was stored.
  TypeScript prevents this in every existing caller; this guard is for the ones
  TypeScript does not see.

  Found through a verification script that forgot to include the key — run with
  `--experimental-transform-types`, which **strips types without checking them**.
  For several minutes the result read exactly like a tenant policy that did not
  work.
- **The SSE stream has not been tested behind a real proxy** —
  `x-accel-buffering: no` is set, but it has not been verified against an actual
  nginx.

### Leave — what is missing

- **Tiered approval** — §2.4 above. Still a single step, but **two control
  failures in that single step are now closed** (numbers 38 and 39 below): a
  requester can no longer approve their own leave, and replacing the designated
  approver is now recorded.
- **`Employment.managerId` is never read** — the column exists, can be set
  through the assignment endpoint, and no path uses it. Until it is, the approver
  must be **chosen by the requester** from the list of permission holders.
  Automatic tiering (manager → HR) waits for that column to actually be filled;
  routing to a manager nobody ever designated would freeze every request.
- ~~**Monthly accrual**~~ — **done.** Number 21 above. `MONTHLY_ACCRUAL` accrues
  1/12 of the quota on each monthiversary of the join date; `ANNIVERSARY` grants
  the full quota on the service anniversary and nothing before it. The
  computation is a **pure function of the join date** (`entitlementAsOf`), not an
  accumulation — so its reconciliation is idempotent and self-correcting: run
  twice in a day the difference is zero, dead for three months and then restarted
  it catches up entirely in one round. It is reconciled in two places:
  `ensureBalance` (on every leave request, so the number is never stale exactly
  when it is used) and a daily worker job (so the balance screen is right without
  waiting for someone to request leave).
  Tested e2e against a real database: an employee joining on 10 March has 0 days
  on 1 April, 3 days on 10 June, and 9 days on 31 December; a second call on the
  same date adds **zero**; the ledger holds both movements with a note explaining
  where the figure came from.
- **`ANNIVERSARY` collides with the calendar year-end close** — a limit worth
  knowing, not a bug. Balance rows are keyed to the calendar year, while an
  `ANNIVERSARY` allowance is born mid-year. An employee whose service anniversary
  falls in July loses their remaining leave on 31 December and gains no new
  allowance until the following July. A tenant using this method **must** set
  `maxCarryOverDays` to their quota. Anniversary-based balance periods are a
  schema change, and they wait for a real tenant using the method.
- ~~**Leave attachments as files**~~ — **done**, and what it closed is worse than
  "not wired to storage". `requiresAttachment` is on for Sick Leave and Maternity
  Leave, and its check read `!input.attachmentKey` over a **free-text** column —
  with a screen showing an input box labelled "Number or name of the doctor's
  note file". Which means the requirement "a doctor's note is mandatory" was
  **satisfied by typing the word 'ada'**. For sick leave, that doctor's note is
  the only thing separating paid leave from absence; a requirement that accepts
  arbitrary text is not a requirement, it is an input box that makes everyone
  believe evidence is stored.

  A doctor's note is **health data** — a specific category of personal data under
  Article 4(2) of the Personal Data Protection Act — so two things apply that do
  not apply to other files: only its owner and holders of
  `leave.request.read.all` can open it, and **every read by anyone else is
  logged**. A refusal answers 404, not 403: with health data, the existence of
  the file is itself information.

  | Attempt | Result |
  |---|---|
  | No attachment | refused |
  | An attachment consisting of the text `"ada"` | **refused** — this was the old hole |
  | A fabricated key of the right shape | refused |
  | Another employee's attachment | refused, with the same message as "not found" |
  | Your own valid attachment | accepted |
  | The same attachment, used again | refused |
  | A shell script named `.pdf` | refused on its **magic bytes**, not its name |
  | An orphan under 24 hours old | kept |
  | An orphan over 24 hours old | discarded; the ones in use are not |

### Two control failures in leave approval

Found by trying it, not by reading the code.

38. **`currentApproverId` was written but never read.** The requester picks their
    approver, the system records it, and then ignores it entirely — anyone
    holding `leave.request.approve` could decide anyone's request. That column
    merely decorated the inbox. Replacement is **still allowed** — HR must be able
    to stand in for a manager who is on leave or has left, and a system demanding
    the exact approver would freeze every request each time someone resigns — but
    it is now **recorded**, on the approval row's comment and in the audit trail.
    What cannot be prevented must be visible: HR standing in for a manager
    occasionally is normal; HR standing in on every single request is a pattern
    worth asking about.
39. **A requester could approve their own leave.** A manager holds the approval
    permission — as they should — so they could request leave and then approve it
    themselves in two clicks, and the result is indistinguishable from a
    legitimate approval. It is now refused **without exception**: a conditional
    escape hatch is a hole waiting for its condition to be met. The accepted
    limit: a company with only one user cannot use the leave flow at all, and
    must use an HR balance adjustment instead.
- ~~**Working days other than Monday–Friday**~~ — **done.** `countWorkingDays`
  now reads `attendance.schedules`, the same source the attendance module uses to
  decide `DAY_OFF` status — so attendance and leave cannot disagree about which
  days are working days. A schedule beats the weekend assumption in **both
  directions**: a Saturday scheduled as a working day counts, a Monday scheduled
  off does not. A date with no schedule row falls back to Monday–Friday, so a
  tenant who has scheduled nothing sees no change in behaviour. In a six-day
  factory, a Monday–Saturday request previously deducted five days of balance for
  six working days missed — the company lost a day every time, and the number
  still looked plausible, so nobody noticed.
- ~~**No scheduling screen or endpoint**~~ — **done.** The "Shifts & Schedules"
  menu has been in the database since the first seed and appeared for every HR
  user opening the sidebar — leading to a page that never existed. There is now
  `/attendance/shifts` plus `GET`/`POST /api/attendance/schedules` filling a table
  two modules already read. Generation works from a weekly pattern, with three
  guards that each close a silent failure: it **does not overwrite** an existing
  row unless asked to (hand adjustments — a shift swap, a substitute day off — do
  not vanish silently); it **does not schedule outside employment** (an employee
  who resigned in March but has a schedule through December is recorded ABSENT
  every day, and the whole company's attendance figures break with them); and it
  **does not mark a national holiday as a weekly day off** (attendance checks
  `holidays` first, and swapping it to `DAY_OFF` makes holiday overtime
  invisible). The range is capped at 366 days per generation. Verified against a
  real server: a six-day factory pattern over 3 employees × March 2027 produced
  93 rows; a second generation produced 0 created / 93 skipped; a 732-day range
  was refused with a 400 whose message explains how to split it; staff attempting
  to generate were refused with 403 (P9). Leave computed over that schedule gives
  24 working days for a range the Monday–Friday assumption counted as 20.

### Payroll — what is missing

All of it is locked behind Gate C, not left behind:

- **PPh21 under the TER scheme, PTKP, the December annual calculation**
- **BPJS Ketenagakerjaan (JHT, JP, JKK, JKM) and Kesehatan** with wage ceilings
- **Proration for mid-month joiners and leavers** and **overtime per Kepmenaker**
- **THR as a separate `run_type`** — the enum exists, the calculation does not
- **PDF payslips** and **bank export** (BCA + Mandiri)
- **The 30 golden regression cases** run on every commit

What is not locked behind Gate C but is still unbuilt:

- ~~**Run calculation in the worker**~~ — **done, and its DoD is measured.**
  Number 25 above. `POST /api/payroll/runs/[id]` with the `calculate` action now
  marks the run `CALCULATING`, publishes `payroll.run.requested` to the outbox in
  the same transaction, and returns **202** — not a 200 with zeroes, which would
  read as "a thousand employees, nought rupiah". The worker processes it 50
  employees per transaction as the `hrms_worker` role.

  | Size | Result |
  |---|---|
  | 1,003 employees, 21 chunks | **8.5 seconds** (DoD: < 3 minutes) |
  | Re-run against the same run | 0 new payslips, 13 ms |
  | The old shape, one transaction | failed at second 5.2 |
  | Payslips surviving the old failure | **0** |

  The totals are recomputed from the database at closing rather than accumulated
  in memory: a process that dies on the seventh chunk and is continued by another
  would report the last seven chunks' total as the whole company's total, and
  that number goes into a report with not one error.

  The run screen changed with it: the "Calculate" button now appears only for
  DRAFT and FAILED — previously CALCULATED showed it too and pressing it
  **always** produced a 409, because the server never accepted a recalculation of
  a finished run. A FAILED run shows "Continue", and that word is now accurate.
  The page reloads every three seconds while a run is still calculating, then
  stops on its own.
- **`statutory_configs` has neither a screen nor an endpoint** — the table
  exists; filling it waits on Gate C.

### Commercialisation — what is missing

- **Billing (Midtrans/Xendit)** — demands a payment gateway account and its
  credentials. The subscription model, invoicing, and dunning can be built
  without an account, but the integration cannot be tested without a real
  sandbox.
- ~~**Suspending a customer who does not pay**~~ — **done** (number 32).
  `POST /admin/api/tenants/status`. Suspension deletes nothing: a customer who
  pays their arrears on the third day finds their data intact, and one who never
  returns still has a right to their portability export. Sessions already running
  are not force-revoked — an issued access token stays valid until it expires,
  while login and refresh are refused from that second on. The window is as wide
  as an access token's lifetime, and that is accepted: forced revocation demands
  a revocation list read on every request, and that cost is borne by every
  customer who is never suspended.
- ~~**The admin plane has no screens at all**~~ — **done.** `/admin` now holds a
  console: log in with TOTP, a tenant summary by status, search, and a per-tenant
  management panel to turn modules on and off and change subscription status.

  **Its session is deliberately non-persistent.** A superuser token lives 8 hours
  and only in React memory — refreshing the page means logging in again, TOTP
  included. That inconvenience is chosen: this plane holds every customer's
  metadata, its accounts can be counted on one hand, and it is used a few times a
  month. Trading the convenience of a long session for an XSS surface that
  survives a page load is the wrong trade here — unlike the tenant plane, which
  hundreds of people use every day and which therefore does have an httpOnly
  refresh cookie. Stated on its login screen rather than discovered when the
  session disappears.

  The management screen distinguishes **"enabled"** from **"included in the
  plan"**, because entitlement is the intersection of the two. A module that is
  enabled but outside the plan carries an explicit warning — without it, a
  superuser looking at a ticked box would not understand why their customer is
  still refused with 402. That distinction was immediately useful: it explains why
  the demo tenant refuses every payroll endpoint (its module is outside the
  `starter` plan), something previously visible only as an unexplained 402.

  Verified against a real server, entirely over HTTP:

  | Step | Result |
  |---|---|
  | Disabling a core module | **409** — "A core module cannot be disabled" |
  | Disabling the leave module | 200, the customer is then refused with **402** |
  | Turning it back on | 6 leave types visible again — **the data is intact** |
  | Suspending without an adequate reason | **400** |
  | Suspending with a reason | 200, the previous status recorded |
  | The customer attempts to log in | **403 TENANT_SUSPENDED** |
  | Reactivating | login returns 200 again |
- **Billing remains the only thing missing.** Everything else — self-service
  registration, the 14-day trial, module activation, the dashboards, hardening,
  and the portability export — is running and proven.
- ~~**Web Push**~~ — **done.** `NotificationChannel.WEB_PUSH` has been in the
  enum since the notification module was built with not one producer; it is now
  filled. A leave decision sends a push to all of the requester's devices — its
  two topics were previously `drain`ed, recorded and discarded, so the most
  awaited answer in this system was visible only to whoever opened the app
  themselves.

  **Push is an addition, not a replacement** (document 04 §R52). Web Push does not
  work on iOS unless the PWA has been installed to the Home Screen, and most
  users do not install it — hanging important news on it means moving it to a
  channel that silently fails to arrive for half the users. An empty VAPID key
  means push is off, and that is a valid state.

  Its content is deliberately thin: the decision, the dates, the number of days.
  **No request reason, no approver comment.** A notification appears on a lock
  screen that anyone near the device can see, and push encryption does not help
  there.

  Notification permission can only be requested **once** by the browser. So every
  condition that would make a subscription certain to fail — an unsupported
  browser, an unconfigured server, an iOS device without the PWA installed — is
  checked **before** permission is requested. It is offered on the leave page,
  not in settings: a permission request that appears while someone is waiting for
  an answer is far more likely to be accepted.

  Logout unsubscribes **before** discarding the session — unsubscribing calls an
  endpoint that demands a token. Without that, a shared device keeps receiving
  the previous user's notifications, and no error appears anywhere.

  Verified against a TLS-enabled mock push service:

  | Push service response | Result |
  |---|---|
  | 201 | `sent=1`, the subscription is kept |
  | 410 Gone | `pruned=1`, its row is deleted |
  | 404 | `pruned=1`, its row is deleted |
  | 500 | `failed=1`, kept until it has failed 10 times |

  **The first version of this test passed for the wrong reason**, and that is
  recorded because the shape recurs in this project: a fabricated `p256dh` key
  made encryption fail locally, so not one HTTP request was ever sent — and the
  `failed=1` it reported came from a completely different failure than the one
  under test. Only with real P-256 keys and a TLS server did the 410 path prove
  it genuinely prunes.

  A known limit: this path has **never been tested against a real push service**
  (FCM, Mozilla, Apple), and has not been tested on an iOS device with the PWA
  installed.
- **WhatsApp does not exist yet.** It is the third tier for urgent matters, and
  demands a WhatsApp Business API account and its credentials.
- ~~**`.xlsx` export across every module**~~ — **done.** Attendance, leave, and
  payroll now each have their own export, following the employee module. This is
  not a small gap in the target market: in Indonesia every report ends up in
  Excel — the attendance recap to reconcile against the old attendance machine,
  the leave recap for the monthly meeting, the payroll recap for finance and for
  the bank's bulk transfer upload. HR who cannot download it copy it off the
  screen by hand, and a hand copy is where numbers change without anyone knowing.

  Three rules apply to all four, and all three are verified:

  - **Audited.** The audit row records who, when, which filters, how many rows,
    and — for the payroll recap — whether masking was lifted. Proven in the
    trail: `{"runId": …, "rowCount": 3, "unmasked": true, …}`.
  - **It does not bypass masking.** Tested with a real bank account number rather
    than an empty column that happens to pass: without `employee.pii.unmask` the
    file contains `*********0123`; with that permission, the full number — which
    the bank transfer file genuinely needs.
  - **Bounded, and it admits truncation.** `x-export-rows` and
    `x-export-truncated` on every response, and the screen states the truncation
    plainly. A silently truncated file looks exactly like a complete one.

  A date range is **mandatory** on the attendance export — there is no "all"
  default. An attendance recap with no date bound is every person's entire
  attendance history at the company: a file nobody needs and that should not be
  in circulation.
- **The monthly attendance recap** — **done.** One row per employee: present,
  late, absent, on leave, minutes late, minutes of overtime, hours worked. This
  is the report that actually gets printed, signed, and filed every month, and
  the one finance uses to check deductions before payroll runs.

  What existed before was only a **list of days** — for 100 employees over a
  month that is 3,000 rows, and HR needing 100 numbers summed them in Excel
  themselves. Summing by hand is where numbers change without anyone knowing, and
  a number that changes here becomes a salary deduction.

  The aggregation happens in the database, not by pulling 3,000 rows into process
  memory. One endpoint serves both the screen and the download, distinguished by
  `format` — two endpoints computing the same thing are two places that can
  disagree, and a disagreement between the number on the screen and the number in
  the signed file is the most expensive kind to find.

  **Employees with no recap rows at all are reported separately**, not shown as a
  zero row. An attendance recap is created when it is computed, not automatically
  every night; a zero that comes from "not computed yet" and a zero that comes
  from "genuinely absent" are very different things, and showing them the same
  way makes the first read as the second — and then enter a salary deduction.
  Proven in a test: 3 employees, one of them without data, and the screen says so.

  Late **still counts as present**, and is shown as an additional column. Counting
  it separately makes "present + late + absent" fail to equal the working days,
  and whoever reads it will think a day has gone missing.
- **There are no charts or month-over-month trends.** What exists is one month at
  a glance.
- **The P6 hardening is complete**: per-tenant quotas (600/minute, with refusals
  recorded), `statement_timeout`/`lock_timeout`/
  `idle_in_transaction_session_timeout` per role, daily schema drift detection
  through `public.schema_drift_report()`, and a
  [five-incident runbook](../ops/RUNBOOK.md).

### Phase 3 DoD items not yet verified

All of them demand a tool or a device not yet used, not code not yet written:

- [ ] Lighthouse PWA 100, Performance ≥ 90 on the mobile profile
- [ ] Tested on Chromium and WebKit, and on ≥2 real physical devices
- [x] **An automated test proving sensitive endpoints do not enter Cache
      Storage** — `apps/web/test/service-worker.test.ts` runs the actual
      `public/sw.js` inside a VM context, not a copy of it. Verified through
      mutation testing: removing the `NEVER_CACHE` guard fails 3 tests, removing
      the `Authorization` guard fails 1.
- [ ] Verification that the cache and push subscription are fully wiped on
      logout, on a real device

### The gates

- **Gate A** — three pilots importing ≥100 employees unaided. Untested.
- **Gate B** — one paying tenant. Untested.
- **Gate C** — a payroll expert engaged + 30 agreed calculation test cases.
  **A hard precondition for P5**, not started.

With P4 done, the **"Basic without payroll"** plan (Employees + Attendance +
Leave) is technically ready to sell — three of the four features in the reference
Basic plan.
