# P6-18.1 — OpenAPI coverage test

| | |
|---|---|
| **Date** | 2026-10-21 |
| **Task** | `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` §P6-18.1 |
| **Phase** | Phase 6 / Commercialisation and Hardening |
| **Surface** | web |
| **Author** | Roo (code mode) |
| **Commits** | |
| **Spec** | `MEMORY/specs/P6-18-api-documentation-access.md` |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

A new structural test `apps/web/test/openapi-coverage.test.ts` asserts that every route in `ROUTE_MANIFEST` has a corresponding path+method entry in the generated OpenAPI document, and that each route is documented (i.e. has a `DOCS` entry rather than falling back to the routeId as summary). The test fails against the current code with 86 undocumented routes, naming each one.

## Why

`docs/SECURITY/02` §18 flagged that a comment in `openapi.ts` claimed a coverage test that did not exist, and 86 routes were undocumented. This task creates the test that makes the gap visible and prevents it from growing silently.

## How

The test imports the real `ROUTE_MANIFEST` and `buildOpenApiDocument`, generates the document in-process, and checks each routeId against the `paths` object. A route is considered undocumented when its `summary` equals the routeId (the generator's fallback). The test names every missing route in its failure message.

## Files and Components Touched

| Path | Change |
|---|---|
| `apps/web/test/openapi-coverage.test.ts` | Created |
| `TASKS/PROGRESS.md` | P6-18.1 → DONE; P6-18 → IN PROGRESS |
| `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` | P6-18 status updated |
| `docs/PLAN/22-RISK-REGISTER.md` | F8 → Mitigated |
| `MEMORY/CHANGELOG.md` | Entry added |

## Decisions Made

| Decision | Rationale | ADR |
|---|---|---|
| Test fails against current code (86 routes) | "Seen to fail" requirement (ADR-020); P6-18.2 will add docs | — |

## Deviations from the Plan

None.

## Tests Added

| Layer | What it covers | Seen to fail |
|---|---|---|
| Structural guard | Every manifest route has a path+method in OpenAPI; every route is documented | Yes — 86 routes fail |

## Abuse Cases Covered

| Abuse case | `SECURITY/02` § | Test |
|---|---|---|
| Comment claims a test that does not exist; 86 routes undocumented | §18 | `openapi-coverage.test.ts` |

## Definition of Done Verification

- [x] `pnpm --filter @hrms/web typecheck` passes
- [x] `pnpm --filter @hrms/web test` runs (test fails as expected with 86 undocumented routes)
- [x] `TASKS/PROGRESS.md` → P6-18.1 → DONE
- [x] `MEMORY/records/2026-10-21-openapi-coverage-test.md` created
- [x] `MEMORY/CHANGELOG.md` entry added
- [x] `docs/PLAN/22` F8 status updated

## What Did Not Work

N/A.

## Follow-Ups

- P6-18.2: Add `DOCS` entries for all 86 undocumented routes, shrinking the allowlist to zero.

## What to Watch

The test will continue to fail until P6-18.2 is complete. This is the intended "seen to fail" state.
