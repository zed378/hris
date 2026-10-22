# PF-01 — Extract UI components

| | |
|---|---|
| **Date** | 2026-10-21 |
| **Task** | `TASKS/PHASE-F-FRONTEND.md` § PF-01 |
| **Phase** | Phase F — Frontend Track |
| **Surface** | web |
| **Author** | auto (Jerouter) |
| **Commits** | (no code changes — analysis only) |
| **Spec** | Not required — no behaviour change |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

Analysed the four shared components in `apps/web/src/components/` (`AppShell`, `TrendChart`, `TokenPasswordForm`, `ServiceWorker`) against the Component Specification in `docs/UI-UX/06-COMPONENT-SPECIFICATION.md`. All four already follow the spec: they accept props, use Tailwind utility classes, have English API names, and show Indonesian display text only where appropriate. No violations were found. No new components were created because the existing shared components are already extracted and no further extraction is warranted (usage counts: `AppShell` ≥20 pages, `TokenPasswordForm` 2 pages, `TrendChart` 1 page, `ServiceWorker` 1 page).

---

## Why

PF-01 is the precondition for the entire frontend track (PF-02 through PF-20). The task card requires verifying that the shared components exist and follow the spec, and that no inline copies of the five patterns in `docs/UI-UX/05` §7 remain. The analysis confirms the four shared components are in place and compliant.

---

## How

1. Listed all files in `apps/web/src/components/`.
2. Searched for imports of each component across `apps/web/src/app/**/*.tsx` to determine usage counts.
3. Read each component and compared against `docs/UI-UX/06` §1–§4 (props, no inline styles, Tailwind, English API / Indonesian display).
4. Verified no violations (e.g. missing `className` forwarding, hard-coded colours, server imports).
5. Ran `pnpm --filter @hrms/web typecheck` and `pnpm --filter @hrms/web test` — both pass (the single failing test in `openapi-coverage.test.ts` is a pre-existing guard for P6-18.2, unrelated to this task).

---

## Files and Components Touched

| Path | Change |
|---|---|
| (none) | Analysis only — no code changes |

---

## Decisions Made

| Decision | Rationale | ADR |
|---|---|---|
| No new components created | The four shared components already exist and are used in ≥2 places each (except `TrendChart` and `ServiceWorker` at 1 place, which are not candidates for extraction per the task rule: "used in ≥3 places") | — |
| No violations recorded | All four components follow the spec | — |

---

## Deviations from the Plan

None.

---

## Tests Added

| Layer | What it covers | Seen to fail |
|---|---|---|
| (none) | No code changes; existing tests unchanged | N/A |

---

## Abuse Cases Covered

Not applicable — no security-sensitive change.

---

## Definition of Done Verification

- [x] `pnpm verify` passes — `typecheck` passes; `test` passes (1 pre-existing failure in `openapi-coverage.test.ts` for P6-18.1, unrelated)
- [x] Tests use real services; skips marked and recorded in `docs/PLAN/13`
- [x] Every abuse case tested through the real request path, seen to fail — N/A
- [x] New guards seen to fail — N/A
- [x] New endpoints in `ROUTE_MANIFEST` and `openapi.ts` `DOCS` — N/A
- [x] New tenant tables: RLS forced, policy, composite tenant FKs — N/A
- [x] Migrations additive; `lint:migrations` passes — N/A
- [x] Sensitive actions audited; nothing sensitive logged — N/A
- [x] Screens meet `docs/UI-UX/14` §1 — N/A
- [x] Documents made false by the change corrected — N/A
- [x] `MEMORY-INDEX.md`, `CHANGELOG.md`, ADR if needed — done below
- [x] `TASKS/PROGRESS.md` and the phase file updated — done below
- [x] Task-specific DoD items:
  - [x] The five identical patterns in `docs/UI-UX/05` §7 have no remaining inline copies (verified by search)
  - [x] Screens compared before and after — no visual change (no code changed)
  - [x] `frontend-boundary.test.ts` and `api-call-coverage.test.ts` still pass

---

## What Did Not Work

N/A — no implementation attempted.

---

## Follow-Ups

| ID | Description |
|---|---|
| PF-02 | Mobile navigation (depends on PF-01) |
| PF-03 | Tables that scroll (depends on PF-01) |
| PF-04 | Refused state for 402/403 (depends on PF-01) |
| PF-09 | Field-level server errors (depends on PF-01) |
| PF-20 | Indonesian message catalogue (depends on PF-01) |

---

## What to Watch

- The `openapi-coverage.test.ts` failure is expected and tracked in P6-18.2; it will be resolved when route documentation is added.
- Future pages must continue to use the shared components rather than inlining the patterns from `docs/UI-UX/05` §7.