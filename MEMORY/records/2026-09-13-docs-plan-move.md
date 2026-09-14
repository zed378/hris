# Move `PLAN/` Under `docs/PLAN/`

| | |
|---|---|
| **Date** | 2026-09-13 |
| **Task** | — (documentation restructuring requested by the user) |
| **Phase** | — |
| **Surface** | docs, and comments across the code |
| **Author** | Claude Code (Claude Opus 5) |
| **Commits** | `f3d19ba` |
| **Spec** | Not required — no behaviour change |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

`PLAN/00`–`14` moved to `docs/PLAN/` with `git mv`, preserving history. Every reference to `PLAN/` in the repository — code comments, tests, migrations, ops files, the README — was rewritten to `docs/PLAN/`. 145 files, 256 insertions, 256 deletions.

## Why

The user asked for a `docs/` directory structured like `zed378/zed-auth`, adapted to this codebase. `zed-auth` keeps its plan under `docs/PLAN/`. ADR-022.

## How

A script (kept outside the repository) with three properties that mattered:

1. **A boundary-aware pattern**: `(?<![A-Za-z0-9_])PLAN/`, so `docs/PLAN/` and identifiers containing `PLAN` are never rewritten twice.
2. **Idempotent link deepening** inside the moved documents: relative links leaving the folder (`](../`) became `](../../` only where not already deepened — a negative lookahead, after a first version using plain string replacement proved non-idempotent.
3. **Extensionless files included** — `Dockerfile.auth`, `Dockerfile.web`, `Dockerfile.worker`, `.npmrc` — after the first run missed five references in them.

Files with uncommitted changes from anyone else were skipped.

## Files and Components Touched

| Path | Change |
|---|---|
| `PLAN/*` → `docs/PLAN/*` | Moved |
| `docs/PLAN/13` | Links to `ops/RUNBOOK.md` and `ops/proxy-test/README.md` deepened |
| 130 other files | `PLAN/` → `docs/PLAN/` in comments and text |

## Decisions Made

| Decision | Rationale | ADR |
|---|---|---|
| Keep `00`–`14` numbering; new topics from `15` | Code cites `PLAN/NN §x`; renumbering would silently repoint citations | ADR-022 |

## Deviations from the Plan

None.

## Tests Added

None — text-only change.

**Verification performed**: every changed file was compared with its previous version after reversing the substitution. Result: 84 files identical; 48 differing only in line endings (`core.autocrlf=true`); **0 real differences**. An earlier line-by-line comparison reported 110 false differences because its filter for diff headers (`^---`) also dropped SQL comment lines beginning `-- `; it was replaced by the whole-file comparison.

**Not run**: `pnpm verify`. The local PostgreSQL, Redis, and NATS containers were not running, and the change touched only comments and documentation paths. Stated here rather than implied.

## Abuse Cases Covered

Not applicable — no behaviour change.

## Definition of Done Verification

- [ ] `pnpm verify` — **not run** (services down; comments and paths only)
- [x] No behaviour change — verified by reversed-substitution comparison
- [x] Explicit file list committed; other tools' uncommitted changes excluded
- [x] ADR-022

## What Did Not Work

- `git mv PLAN docs/PLAN` failed until `docs/` existed.
- The first link-deepening approach was not idempotent.
- The first comparison method produced false positives on SQL comments.

## Follow-Ups

- Run `pnpm verify` when services are next up, to confirm no string that code reads at runtime contained `PLAN/`.

## What to Watch

- A new comment citing `PLAN/NN` without `docs/`.
