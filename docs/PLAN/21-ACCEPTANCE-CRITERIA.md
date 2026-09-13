# 21 — Acceptance Criteria

What must be true before something is called done — for a single change, for a phase, and for a release to paying customers. Phase-level definitions of done already exist in `12-Small-Team-Execution-Plan.md` §6 and are not repeated; this document gathers them into checkable form and adds the release gates.

Each criterion states **how it is verified**. A criterion without a verification method is an opinion.

---

## 1. Every Change

Required of every task card in `TASKS/`, on top of the card's own definition of done:

| # | Criterion | Verified by |
|---|---|---|
| C1 | `pnpm verify` passes: migration lint, lint, typecheck, tests, build | Running it; the output in the record |
| C2 | A new endpoint has a `ROUTE_MANIFEST` entry with module and permission | `route-manifest.test.ts` |
| C3 | A new endpoint has a `DOCS` entry in `openapi.ts` | Review today; a coverage test once `TASKS/` delivers it |
| C4 | A new page reached from a menu exists, and its calls hit real endpoints | `menu-coverage.test.ts`, `api-call-coverage.test.ts` |
| C5 | A new table with `tenant_id` has RLS enabled and forced, with a policy | `rls-coverage.test.ts` |
| C6 | A migration is additive and passes `lint:migrations` | The lint |
| C7 | Tests touching data use real services, not mocks | Review against `16-TESTING-STRATEGY.md` §1 |
| C8 | Security-sensitive work has an abuse-case test from `SECURITY/02` | The test names the scenario id |
| C9 | A new guard has been seen to fail | Stated in the record, with the violation used |
| C10 | A frontend control has a backend refusal (P9) | A test calling the endpoint without the permission |
| C11 | User-facing text follows `UI-UX/13-LANGUAGE-AND-COPY.md` | Review |
| C12 | A record exists in `MEMORY/records/` and `MEMORY/CHANGELOG.md` is updated | The files |

## 2. Gates

`12` §6 defines four gates. They are **business gates, not engineering gates**: each asks whether the market has answered a question before more is built. A green build never opens one.

| Gate | Checked | Condition | State on 2026-09-13 |
|---|---|---|---|
| **A** | Before Phase 3 | Three pilot companies import ≥ 100 real employees from their own Excel files in under 30 minutes, with no help | No pilot import recorded in this repository |
| **B** | Before Phase 4 | At least one tenant **pays** for Employees + Attendance | No paying tenant recorded; billing not built |
| **C** | Before the first line of payroll | A payroll/HR expert is engaged; 30 real payslips collected with expected results; spike S1 passes 30/30 | **Not met.** The payroll *framework* (components, formulas, structures, runs) was built; the statutory calculation was not |
| **D** | Before each Phase 7+ module | Adoption of the previous module exceeds 30% of active tenants | Not reached |

Phases 3–5 were implemented ahead of Gates A–C. That is recorded as a deviation in `MEMORY/DECISIONS.md` and `TASKS/BACKLOG.md`, not rewritten here as if the gates had been met.

## 3. Tenant Isolation (every release)

Non-negotiable; a single failure blocks any release. From `12` Phase 1 DoD.

| Criterion | Verified by | State |
|---|---|---|
| A tenant A token cannot read one row of tenant B, on every table | `tenant-isolation.test.ts`, `gateway.test.ts` | Met — **locally; there is no CI** |
| Zero routes without a `ROUTE_MANIFEST` entry | `route-manifest.test.ts` | Met — locally |
| Module boundaries hold | `eslint-plugin-boundaries` | Met — locally |
| No runtime role has `BYPASSRLS` or owns a tenant table | `rls-coverage.test.ts` | Met |
| A superuser cannot read tenant data | `rls-coverage.test.ts` grant matrix | Met |
| `schema_drift_report()` returns no rows on the target database | Running it | Per deploy |

## 4. Phase Definitions of Done — Verification State

The checklists are `12` §6. This section records, for each item, how it is verified and whether it has been — so a reader can see what "Phase N done" actually rests on.

### Phase 2 — Employees & Excel Import

| Item | Verified by | State |
|---|---|---|
| Three pilots import ≥ 100 employees unaided in < 30 min | Pilot sessions | **Not verified** (Gate A) |
| Export opens in Excel and matches row for row | Manual comparison | `.xlsx` export built; row-for-row comparison not recorded |
| Import errors per row, correctable and re-uploadable | Import pipeline | Built |
| PII masked by permission; unmasking audited | Employee endpoints | Built |

### Phase 3 — Attendance & PWA

| Item | Verified by | State |
|---|---|---|
| A punch outside the geofence is recorded and flagged, never lost | `trust.ts`, running app | Verified |
| A denied permission is handled per tenant policy | `policy.ts`; running app | Verified — but `FALLBACK_ONLY` is **bypassable** through `X-Forwarded-For` (`SECURITY/02` §4) |
| A flagged punch enters the review queue | Review endpoints | Verified |
| EXIF stripped; photos deleted after retention, attendance rows intact | `photo.ts`; retention job | Verified |
| Offline punches replay with no duplicate even if flushed twice | `dedupeKey`; offline queue test | Verified |
| Sensitive endpoints never enter Cache Storage | `service-worker.test.ts` | Verified |
| Cache and push subscription wiped on logout | Service worker | Built; not verified on a shared physical device |
| Tokens never in Cache Storage or IndexedDB | `session.tsx` (memory only) | Verified |
| Lighthouse PWA 100, Performance ≥ 90 mobile | Lighthouse | **Not run** |
| Chromium, WebKit, and ≥ 2 real devices | Devices | **Not run** |

### Phase 4 — Leave

| Item | Verified by | State |
|---|---|---|
| Submission through approval; balance deducted accurately | Running app | Verified |
| 50 concurrent approvals against 2 days → exactly 1 succeeds | Concurrency run | Verified (`13` §3) |
| Balance never negative; every movement has a ledger row | `balance.ts` | Built |
| Team calendar limited to the manager's scope | `leave.request.read.team` | Built |

### Phase 5 — Payroll

| Item | Verified by | State |
|---|---|---|
| 3 parallel cycles identical to the rupiah | Parallel run | **Not possible** before Gate C |
| 1,000 employees in < 3 minutes | Load run | **Not run** |
| The same run twice produces one run | Partial unique index → `409` | Built |
| Killing the worker mid-calculation → no duplicate payslip | Worker kill test | **Not run** |
| A payslip visible only to its owner and permitted roles, cross-tenant token tested | Gateway tests | Partially |
| A tax rate change through configuration, no redeploy | `statutory_configs` | Table exists; no statutory component consumes it |
| MFA available for payroll roles | — | **Not built** |

### Phase 6 — Commercialisation & Hardening

| Item | Verified by | State |
|---|---|---|
| Register, try, pay, enable a module without the team | Running app | Register and trial exist; **payment not built** |
| Disabling a module hides the menu, refuses the API, keeps the data | `gateway.test.ts` (`402`); no delete path on unsubscribe | Refusal verified; data retention by design, not tested |
| A subscription change reflected in the UI within 10 s without re-login | Tenant generation bump | Built |
| Full tenant export on request | `data-export.ts` | Built |

## 5. Personal Data (every release touching PII)

- [ ] National ID, tax ID, and bank account are ciphertext in the database
- [ ] Unmasking writes an audit row
- [ ] Logs from the release contain none of the above (`logger.test.ts`, plus a grep of a real log)
- [ ] The portability export contains no ciphertext or password hashes

## 6. UX (every release touching screens)

`UI-UX/14-UX-ACCEPTANCE-CRITERIA.md` holds the full list. The minimum:

- [ ] Every screen touched works at 360 px width
- [ ] Every screen touched has loading, empty, error, and refused (`402`/`403`) states
- [ ] Every interactive element touched is reachable by keyboard
