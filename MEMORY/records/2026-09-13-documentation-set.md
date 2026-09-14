# Documentation Set — `docs/`, `TASKS/`, `MEMORY/`, `CLAUDE.md`, `AGENTS.md`

| | |
|---|---|
| **Date** | 2026-09-13 to 2026-09-14 |
| **Task** | — (requested by the user) |
| **Phase** | — |
| **Surface** | docs |
| **Author** | Claude Code (Claude Opus 5) |
| **Commits** | `72da8ec`, `27558b2`, `8a7b829`, `da6666d`, `df5013b`, `2bca951`, and the commits adding `MEMORY/`, `CLAUDE.md`, `AGENTS.md` |
| **Spec** | Not required — documentation |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

Added, modelled on `zed378/zed-auth` and adapted to this codebase:

| Folder | Files | Content |
|---|---|---|
| `docs/README.md` | 1 | Reading order, the zed-auth topic mapping, principles enforced in code |
| `docs/PLAN/15`–`23` | 9 | API contract, testing, security baseline, performance, observability, deployment and DR, acceptance criteria, risk register, feature spec template |
| `docs/SECURITY/` | 6 | Assets and boundaries, threat actors, 21 attack scenarios, detection, playbooks, verification |
| `docs/UI-UX/` | 15 | Direction, personas, journeys, IA, flows, design system, components, page inventory, interaction, mobile, accessibility, states, forms, copy, UX acceptance |
| `TASKS/` | 13 | Conventions, board, backlog, eight phase files and the frontend track |
| `MEMORY/` | README, index, changelog, 29 ADRs, templates, 5 records, 2 draft specs | |
| Root | 2 | `CLAUDE.md`, `AGENTS.md` |

## Why

The user asked: study the codebase; create `docs/` like `zed-auth`'s, adapted; create `MEMORY/` and `TASKS/`; create `CLAUDE.md` and `AGENTS.md`. They asked to focus on the documents and discuss open questions later — so questions are recorded in `TASKS/BACKLOG.md`, not raised.

## How

Every "current state" claim was checked against the code, the tests, the migrations, `docs/PLAN/13`, `docs/PLAN/14`, `ops/RUNBOOK.md`, or git history **before** it was committed, by searching for the file, identifier, or figure named. `zed-auth` wrote its documents before its code; here the documents describe a running system, so they are descriptive where the system exists, prescriptive where they set a rule, and explicit about gaps.

## Findings

Found while writing, recorded, **not fixed** (the user asked for documents only):

| Finding | Where recorded | Task |
|---|---|---|
| `X-Forwarded-For` first entry trusted in three places; office-network verification, `FALLBACK_ONLY`, per-address rate limits, and audit addresses are client-controlled | `SECURITY/02` §4, risk F1 | `P3-12` |
| Unmasked PII viewed in employee list or detail writes no audit row (Phase 2 DoD requires it) | `SECURITY/02` §8(e), F11 | `P2-08` |
| No permission ceiling for role and grant administrators | `SECURITY/02` §5(a), F12 | `P6-13` |
| Superuser TOTP secrets stored in plaintext; superuser logins not audited | `SECURITY/02` §9, F13 | `P6-14` |
| No CSP, HSTS, or frame-ancestors headers | `SECURITY/02` §13, F5 | `P6-12` |
| Internal secret compared with `!==` | `SECURITY/02` §10(b) | `P6-15` |
| No CI pipeline | `PLAN/16` §4, F2 | `P0-09` |
| No alerting; no error tracking; no uptime check | `PLAN/19` §6, F3 | `P6-16`, `P1-16`, `P1-17` |
| Every backup on the database host; PII keys in no backup | `PLAN/20` §6–7, F4 | `P6-17` |
| `openapi.ts` claims a coverage test that does not exist; 14 of 100 routes documented | `PLAN/15` §9, `PG-04` | `P6-18.1` |
| No mobile navigation; no link back home on phones | `UI-UX/09`, F6 | `PF-02` |
| No page renders a designed `402`/`403` state; `/modules/[code]` unlinked | `UI-UX/11` §5 | `PF-04` |
| No `focus-visible`, one document title for all pages, no live regions | `UI-UX/10` | `PF-06`–`PF-08` |
| Self-approval refusal, account lockout, and login timing have no automated test | `SECURITY/05` | `P4-08`, `P6-20` |
| Without `RESEND_API_KEY`, invitations and resets are printed to the log, not sent | `PLAN/20` §4 | — |
| Phases 3–6 built without Gates A/B; payroll framework before Gate C | ADR-015, ADR-016 | — |
| API error message language changed by another tool | `OQ-01` | — |

## Corrections Made to My Own Drafts Before or After Commit

Recorded because each was a plausible claim that the code contradicted — the failure mode these documents warn about.

| Claim first written | What was true | Fixed in |
|---|---|---|
| Gates A–D were engineering release gates | They are business gates: pilots importing, a paying tenant, payroll preconditions, adoption | `PLAN/21` before `27558b2` |
| Leave uses an advisory lock | `SELECT … FOR UPDATE` on the balance row | `PLAN/15` before `27558b2` |
| Two pages render a designed `402` state | None does | `UI-UX/00`, `04` before `8a7b829` |
| PII unmasking is audited | Only exports record it | `PLAN/17`, `SECURITY/*` before `27558b2` |
| `office-network.test.ts` runs against PostgreSQL | It tests pure functions | `PLAN/23` before `72da8ec` |
| Lockout and self-approval have tests | Neither does | `SECURITY/05` before `27558b2` |
| Superuser logins are in the platform audit | Only status and plan changes are | `PLAN/17`, `19`, `SECURITY/02`, `03` before `27558b2` |
| No page links onward on a phone | The home dashboard cards do; nothing links back | `UI-UX/00`, `02`, `03` before `8a7b829` |
| Uploaded files are in no backup | `backup.sh` archives the storage directory | `PLAN/20`, F4 in `da6666d` |
| New risks numbered `N1`… | `PLAN/12` §10.3 already uses N1–N7; renamed `F1`… | `da6666d` |
| 1,000-employee payroll unmeasured | Framework measured: 1,003 in 8.5 s | `PLAN/18`, `21` in `df5013b` |
| "Two guards were inert"; then corrected to one | Two guards failed: the boundary test matched nothing, the manifest check missed `export function` handlers | `df5013b`, then the MEMORY commit |
| `PLAN/07` is the payroll document; `PLAN/04`'s filename | `07` is the dashboard; `04` is `04-Development-Phases.md` | `2bca951` |
| `a13cfca` dated 2026-09-13; "50 messages" translated | Dated 2026-09-01; the count was not verified | MEMORY commit |
| Invitations email fallback for push | Leave decisions use push only | `UI-UX/08` before `8a7b829` |
| `brand-500` used for focus rings | Used for input focus borders | `UI-UX/05` before `8a7b829` |

## Tests Added

None — documentation only. `pnpm verify` was **not run**: the local database, Redis, and NATS containers were not running, and no code changed.

## Abuse Cases Covered

Not applicable. The documents define the abuse cases future tasks must test.

## Definition of Done Verification

- [x] Every current-state claim checked against code or a recorded source before commit
- [x] Findings recorded with tasks rather than fixed silently
- [x] Open questions recorded, not decided (`TASKS/BACKLOG.md`)
- [x] Explicit file lists on every commit
- [ ] `pnpm verify` — not run; no code changed

## What Did Not Work

Writing a section from memory of an earlier read, then checking. Every row in the corrections table began that way. Checking before writing was slower and produced far fewer corrections.

## Follow-Ups

`TASKS/PROGRESS.md` Next Up. `PG-03` (`docs/PLAN/13` stale in places) and `PG-05` (superseded notices on `PLAN/01`, `04`) are deliberate edits awaiting approval.

## What to Watch

- Documents drifting from the code as tasks land. Global DoD item 10 requires correcting them in the same commit.
- `docs/PLAN/13` remains the build's own record and is older than `docs/PLAN/15`–`23`; where they disagree about current state, the newer document was checked more recently — confirm against the code.
