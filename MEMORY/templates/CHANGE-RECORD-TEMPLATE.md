# <Task ID> — <Short Title>

| | |
|---|---|
| **Date** | YYYY-MM-DD |
| **Task** | `TASKS/PHASE-<n>-....md` § <task id> |
| **Phase** | Phase <n> / Track S / Track F |
| **Surface** | backend / web / worker / auth / db / ops / docs |
| **Author** | <person or agent, and which tool> |
| **Commits** | |
| **Spec** | `MEMORY/specs/<task-id>-<slug>.md` or "Not required — because …" |
| **Status** | Completed / Partially completed / Reverted |
| **Reconstructed** | No |

---

## What Changed

Two or three sentences: what exists now that did not, or behaves differently.

## Why

Why now, and which plan sections it implements — `docs/PLAN/15-API-CONTRACT.md` §9, not "the API doc". If the task came from something found during other work, say so.

## How

The approach, at the level a reader needs before opening the code. Name anything non-obvious: a workaround, a place where the straightforward approach was wrong for a reason not visible locally.

## Files and Components Touched

| Path | Change |
|---|---|
| | |

## Decisions Made

| Decision | Rationale | ADR |
|---|---|---|
| | | |

## Deviations from the Plan

The conflict, what was chosen, whether the user approved it, whether the plan document is amended. "None" if none.

## Tests Added

Real services only (`docs/PLAN/16` §1). State for each whether it was **seen to fail** first.

| Layer | What it covers | Seen to fail |
|---|---|---|
| Unit | | |
| Integration (PostgreSQL / Redis / NATS) | | |
| Structural guard | | |
| Running application | | |

Tests skipped, and why:

## Abuse Cases Covered

Every abuse case on the task card, from `docs/SECURITY/02`.

| Abuse case | `SECURITY/02` § | Test |
|---|---|---|
| | | |

## Definition of Done Verification

The task's DoD and the global DoD (`TASKS/00-TASK-CONVENTIONS.md` §4). **A waived item says which, why, and who agreed.**

- [ ] `pnpm verify` passes — output summary below; run locally or in CI (say which)
- [ ] Tests use real services; skips marked and recorded in `docs/PLAN/13`
- [ ] Every abuse case tested through the real request path, seen to fail
- [ ] New guards seen to fail
- [ ] New endpoints in `ROUTE_MANIFEST` and `openapi.ts` `DOCS`
- [ ] New tenant tables: RLS forced, policy, composite tenant FKs
- [ ] Migrations additive; `lint:migrations` passes
- [ ] Sensitive actions audited; nothing sensitive logged
- [ ] Screens meet `docs/UI-UX/14` §1
- [ ] Documents made false by the change corrected (`PLAN/13`, `PLAN/22`, `SECURITY/02`, …)
- [ ] `MEMORY-INDEX.md`, `CHANGELOG.md`, ADR if needed
- [ ] `TASKS/PROGRESS.md` and the phase file updated
- [ ] Task-specific DoD items:

```
<pnpm verify output summary>
```

## What Did Not Work

Approaches tried and abandoned, and why. Often the most useful section.

## Follow-Ups

New tasks or backlog entries this work created, with their IDs.

## What to Watch

What could go wrong later because of this change, and the signal that would show it.
