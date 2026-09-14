# TASKS/ — Execution Plan

`docs/PLAN/`, `docs/UI-UX/`, and `docs/SECURITY/` describe **what** to build and **why**. This folder describes **what is done, what to do next, in what order, and how to know it is finished**.

Nothing here invents architecture. Every task points back to the document that decided the design. A task that needs a decision the documents do not contain is not a task — it is an entry in [`BACKLOG.md`](./BACKLOG.md) under Open Questions, raised with the user rather than decided silently.

## This Folder Was Written After Most of the Build

The structure follows [`zed378/zed-auth`](https://github.com/zed378/zed-auth), where tasks were written before any code. Here, Phases 0–6 of [`docs/PLAN/12`](../docs/PLAN/12-Small-Team-Execution-Plan.md) and stages 1–7 of [`docs/PLAN/14`](../docs/PLAN/14-Service-Split-and-Platform-Evolution.md) were largely built between 2026-08-18 and 2026-09-01, and this folder was created on 2026-09-13.

So each phase file has two parts:

1. **Delivered** — a table of what was built, each row with its evidence (a test, a `PLAN/13` section, a commit). Task IDs in this part were **assigned retrospectively**; they did not exist while the work was done, and there are no per-task specs or records for them. That is stated, not disguised.
2. **Open** — full task cards for what remains. These follow [`00-TASK-CONVENTIONS.md`](./00-TASK-CONVENTIONS.md) completely.

## Files

| File | Purpose |
|---|---|
| [`00-TASK-CONVENTIONS.md`](./00-TASK-CONVENTIONS.md) | Task IDs, statuses, card anatomy, global Definition of Done, Definition of Ready, deviation protocol |
| [`PROGRESS.md`](./PROGRESS.md) | The status board — every task, one line each |
| [`PHASE-0-FOUNDATION.md`](./PHASE-0-FOUNDATION.md) | Repository, spikes S1–S4, discovery artefacts, CI, staging |
| [`PHASE-1-CORE-PLATFORM.md`](./PHASE-1-CORE-PLATFORM.md) | RLS, migrations, audit, auth, tenancy, IAM, `ROUTE_MANIFEST`, outbox, control plane |
| [`PHASE-2-EMPLOYEES.md`](./PHASE-2-EMPLOYEES.md) | Employees, grid, import, PII, contracts, documents — and Gate A |
| [`PHASE-3-ATTENDANCE-PWA.md`](./PHASE-3-ATTENDANCE-PWA.md) | Shifts, punching, PWA, offline queue, evidence, trust, live dashboard — and Gate B |
| [`PHASE-4-LEAVE.md`](./PHASE-4-LEAVE.md) | Leave types, accrual, approval, ledger, calendar |
| [`PHASE-5-PAYROLL.md`](./PHASE-5-PAYROLL.md) | The payroll framework (built) and the statutory work behind Gate C |
| [`PHASE-6-COMMERCIALISATION-HARDENING.md`](./PHASE-6-COMMERCIALISATION-HARDENING.md) | Self-service, billing, notifications, hardening, and the security findings of 2026-09-13 |
| [`PHASE-S-SERVICE-SPLIT.md`](./PHASE-S-SERVICE-SPLIT.md) | `docs/PLAN/14` stages 1–8 |
| [`PHASE-F-FRONTEND.md`](./PHASE-F-FRONTEND.md) | **A track, not a sequence position** — mobile navigation, states, accessibility, components |
| [`BACKLOG.md`](./BACKLOG.md) | Open questions (OQ), plan gaps (PG), deviations (DV), deferred items (DF) |

Phase 7+ (data-driven expansion behind Gate D) has no file: nothing in it is scheduled, by design. It is `DF-07` in the backlog.

## How to Use This Folder

1. Open [`PROGRESS.md`](./PROGRESS.md). Pick the highest-priority `TODO` whose dependencies are `DONE` and which no open question blocks. The **Next Up** list at the top of `PROGRESS.md` is the recommended order.
2. **Read every document in the card's Plan refs** — for this task, not from memory of a previous one.
3. If the card says **Spec required: Yes**, write the specification from [`docs/PLAN/23-FEATURE-SPECIFICATION-TEMPLATE.md`](../docs/PLAN/23-FEATURE-SPECIFICATION-TEMPLATE.md) into `MEMORY/specs/<task-id>-<slug>.md` before writing code.
4. Implement against the card's DoD **and** the global DoD.
5. Record in [`../MEMORY/`](../MEMORY/README.md): a change record, an index line, a changelog entry, an ADR if a decision was made or a plan deviated from.
6. Update `PROGRESS.md` and the phase file in the same commit.

## The Phase and Gate Rules

`docs/PLAN/12` §6 sequences phases **and puts business gates between them**:

| Gate | Before | Condition |
|---|---|---|
| A | Phase 3 | Three pilots import ≥ 100 employees unaided in < 30 minutes |
| B | Phase 4 | At least one tenant pays for Employees + Attendance |
| C | The first line of statutory payroll | A payroll expert engaged; 30 real payslips as test cases; spike S1 passes 30/30 |
| D | Each Phase 7+ module | The previous module's adoption exceeds 30% of active tenants |

**Phases 3–6 were built without Gates A or B being met, and the payroll framework was built before Gate C.** That is recorded as deviations `DV-01` and `DV-02` and ADRs 015–016 — not rewritten as if the gates had been passed. The consequence for new work:

- **No further statutory payroll work** (PPh 21, BPJS, proration, THR, bank export) until Gate C is met. Those cards are `BLOCKED`.
- **No Phase 7+ module** until Gate D. Nothing in this folder schedules one.
- Hardening, security fixes, frontend quality, and pilot readiness **are** in scope: they make Gates A and B testable rather than adding breadth.

## Relationship to MEMORY/

`TASKS/` looks forward. `MEMORY/` looks back: what was done, and why it ended up that way. They change in the same commit — a task is not `DONE` until its record exists.
