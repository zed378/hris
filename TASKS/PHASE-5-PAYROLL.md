# Phase 5 — Payroll

**Goal** (`docs/PLAN/12` §6): payroll equal to the reference product's Basic plan — PPh 21 TER, BPJS, proration, overtime, THR, payslips, bank export — proven against real payslips.

**State**: **the framework is built; the statutory calculation is not** (`docs/PLAN/13` §1, §2.5). Gate C says no line of payroll is written before its preconditions are met; the framework was written anyway (`DV-02`, ADR-015). The rule going forward is strict: **nothing statutory is built until Gate C is met.**

> **Gate C — hard preconditions, checked before the first line is written:**
> 1. A payroll/HR expert is engaged.
> 2. 30 real payslips collected with expected results, as executable test cases.
> 3. Spike S1 passes 30/30.
>
> None is met. `OQ-08`, `P0-08`, `P0-13`.

**Phase 5 DoD** (`docs/PLAN/12` §6):

- [ ] 3 parallel cycles identical to the old system to the rupiah — `P5-13`
- [~] 1,000 employees in < 3 minutes — framework: 1,003 in 8.5 s; not measured with statutory components
- [x] The same run twice produces one run
- [~] Killing the worker mid-calculation → no duplicate payslip — re-run proven; mid-chunk kill not recorded
- [~] A payslip visible only to its owner and permitted roles, cross-tenant tested — gateway and RLS tests; no payslip-specific cross-tenant test
- [ ] A tax rate change through configuration without redeploy — `statutory_configs` exists, nothing reads it
- [ ] MFA available for payroll roles — `P5-15`

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P5-01 | Salary components: fixed, per day/hour, percentage, formula; calculated in dependency order, not admin sort order | `/payroll/components`; `payroll-order.test.ts` | DONE (retro) |
| P5-02 | Allowlisted formula parser — no `eval` | `formula.test.ts` (33 cases) | DONE (retro) |
| P5-03 | Per-employee salary structures with period-based history (P13) | `/payroll/structures`, `/api/payroll/salary` | DONE (retro) |
| P5-04 | Payroll runs calculated in the worker in chunks of 50; `202` on request; totals recomputed at close; per-period uniqueness | `docs/PLAN/13` §5 Payroll | DONE (retro) |
| P5-05 | Per-line `calculation_trace` | `packages/core/src/payroll/calculate.ts` | DONE (retro) |
| P5-06 | `run_type` enum including THR (calculation not built) | Migration `20260819130000_payroll_module` | DONE (retro) — schema only |
| P5-07 | Payslip list for the employee | `/payroll/me` | DONE (retro) |
| P5-08 | Versioned `statutory_configs` table with a date range | Same migration | DONE (retro) — no endpoint, screen, or consumer |

---

## Open — Not Blocked by Gate C

### P5-15 — MFA for tenant users, required for payroll roles

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — |
| **Plan refs** | `docs/PLAN/12` Phase 5 DoD, `docs/PLAN/04` R18, `docs/PLAN/17` §9, `docs/SECURITY/02` §2(c) |
| **Spec required** | Yes — authentication |
| **Surface** | backend, auth, web, db |
| **Size** | L |

**Goal** — tenant users can enrol TOTP; a tenant can require it for roles holding `payroll.*` or `employee.pii.unmask`.

**Steps**
1. Spec: enrolment, recovery codes, the login step, the refresh behaviour, and how the requirement is enforced (at login for users holding a flagged permission; bump the access version when the requirement changes).
2. Store the TOTP secret **encrypted** with the PII key ring — not plaintext, which is the superuser defect `P6-14` fixes.
3. Implement in `packages/core/src/auth` so both the in-process path and `apps/auth` use it.
4. Rate-limit the verification step per account, not per address (`P3-12`).

**Definition of Done**
- Enrol, log in with TOTP, use a recovery code, disable with re-authentication.
- A user holding `payroll.run.execute` in a tenant requiring MFA cannot obtain an access token without the second factor — tested through both the in-process route and `apps/auth`.
- Secrets are ciphertext in the database — asserted by test.
- `docs/PLAN/17` §2 and §9, risk R18, `docs/SECURITY/02` §2 updated.

**Abuse cases to test** — `SECURITY/02` §2(c) breached password; TOTP brute force; recovery-code reuse; enrolment by a stolen session without re-authentication.

### P5-16 — Payslip cross-tenant and cross-employee test

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/PLAN/12` Phase 5 DoD, `docs/SECURITY/02` §1 |
| **Spec required** | No — coverage |
| **Surface** | backend |
| **Size** | S |

**Definition of Done** — through the real handlers: an employee reads only their own payslips; a tenant B token reads none of tenant A's; a user with `payroll.payslip.read.all` in tenant A reads A's and none of B's. Seen to fail by removing the ownership filter.

---

## Open — Blocked by Gate C

Each card below is `BLOCKED` by Gate C (`OQ-08`, `P0-08`, `P0-13`). Specs are required for all of them (money). They are listed so the scope is visible, not so they can be started.

| ID | Task | Plan refs | Size |
|---|---|---|---|
| P5-09 | PPh 21 under the TER scheme, PTKP, December annual calculation, gross / net / gross-up | `docs/PLAN/02` (payroll schema), `12` Phase 5 | XL — split |
| P5-10 | BPJS Ketenagakerjaan (JHT, JP, JKK, JKM) and Kesehatan with wage ceilings | same | L |
| P5-11 | Golden regression: 30 real payslips on every commit; a one-rupiah difference fails | `12` Phase 5 quality strategy | M |
| P5-12 | Proration for mid-month joiners and leavers; overtime per Kepmenaker | same | L |
| P5-13 | Parallel run: 3 cycles identical to the customer's existing process | same | L |
| P5-14 | THR calculation as its own `run_type` | same | M |
| P5-17 | `statutory_configs` endpoint and screen; calculation reads the config effective on the pay date | same | M |
| P5-18 | PDF payslips distributed to ESS | same | M |
| P5-19 | Bank export: BCA and Mandiri only | same | M |
| P5-20 | Property tests: net pay never negative, lines sum to header, deterministic recalculation from a snapshot | same | M |
