# Incident — Two AI Tools Committing to One Working Tree

| | |
|---|---|
| **Date** | 2026-09-13 (record); events on 2026-09-01 and 2026-09-13 |
| **Task** | — (process incident) |
| **Surface** | Repository |
| **Author** | Claude Code (Claude Opus 5) |
| **Commits** | `1068293`, `a13cfca`, `170a8b5`, `5d99226` |
| **Status** | Contained; the language question is open (`OQ-01`) |
| **Reconstructed** | Partly — 2026-09-01 events from commit messages; 2026-09-13 events observed first-hand |

---

## What Happened

Two AI coding tools worked in the same working tree at overlapping times: Claude Code, and another tool whose session state had been committed under `.kilo/` (including a file named `…-indonesian-to-english-translation.md`). Commits `a13cfca` and `5d99226` carry no Claude attribution and match the translation pass that `170a8b5`'s message names; they are attributed to the other tool on that basis, not on first-hand observation.

| When | Commit | By | What |
|---|---|---|---|
| 2026-09-01 09:44 | `1068293` | Claude Code | Untracked `.kilo/` tool state that an earlier `git add -A` had swept into history |
| 2026-09-01 10:59 | `a13cfca` | The other tool | "Localize error messages and documentation to English" across `apps/auth`, `apps/web`, `packages/core` — **including user-facing API error messages and notification text** — and added `apps/web/src/lib/openapi.ts` and `GET /api/openapi.json` |
| 2026-09-01 (working tree) | — | The other tool | A concurrent edit left `commitImport` in `packages/core/src/employee/import.ts` with a duplicate closing brace; the build broke (TS1128) |
| 2026-09-01 11:03 | `170a8b5` | Claude Code | Fixed the brace; loosened `jwt-signing.test.ts`, which had matched the Indonesian wording of a configuration error that the translation rewrote, to match `JWT_PRIVATE_JWK` instead. Committed **only those two files**, leaving the translation's other working-tree changes uncommitted because the language of user-facing strings was a product decision |
| 2026-09-13 23:22 | `5d99226` | The other tool | Translated further API error messages, notification text, and comments in `apps/web` to English |
| 2026-09-13 | — | Claude Code | Found `openapi.ts` claiming a CI coverage test that does not exist (`PG-04`), and recorded the language question (`OQ-01`) rather than reverting or extending either tool's work |

## Why It Matters

1. **A build broke with no one editing the broken function on purpose.** The error pointed several statements past the real mistake.
2. **A test failed for a reason unrelated to what it tests** — it asserted on prose that another tool was rewriting.
3. **A product decision was made by a side effect.** "Documentation, comments, and README in English" was applied to strings users read. Nobody decided that; a translation pass did.
4. **Code arrived with a false claim** — a comment describing a test that was never written.
5. **`git add -A` had already committed one tool's private session state** into shared history.

## What Contained It

- Committing by explicit file path, so one tool's commit did not carry the other's half-finished edits.
- Asserting on stable identifiers (an environment variable name, an error code) rather than sentences.
- Refusing to settle the language question by committing it.

## Rules Adopted

Recorded in `TASKS/00-TASK-CONVENTIONS.md` §9, `CLAUDE.md`, and `AGENTS.md`:

- **Stage files by explicit path.** Never `git add -A` or `git add .`.
- **Check `git status` and `git log` before committing** for changes you did not make; leave them out and say so.
- **One agent per working tree.** Parallel agents use separate git worktrees.
- **Tests assert on codes and identifiers, not on prose** (`docs/PLAN/16` §1 rule 7).
- **A translation or bulk-rewrite pass does not touch user-facing strings** without a decision (`OQ-01`).
- **A comment may not claim a test, guard, or behaviour that does not exist.** Review checks claims in comments against the code.

## Follow-Ups

| ID | Item |
|---|---|
| `OQ-01` | Decide the language of API error messages |
| `P6-18.1` | The OpenAPI coverage test the comment claimed |
| `PG-04` | The false claim in `openapi.ts` |
| Risk F7 | Concurrent agents in one working tree (`docs/PLAN/22`) |

## What to Watch

- A commit whose diff touches files outside its stated purpose.
- Tests newly failing on message text.
- Indonesian pages showing English error lines.
