# 00 — Task Conventions

How every task in this folder is written, tracked, and closed. Read once; it applies to every phase.

---

## 1. Task IDs

```
P<phase>-<nn>        P3-12   Phase 3, task 12
PS-<nn>              PS-08   Service split track (docs/PLAN/14)
PF-<nn>              PF-02   Frontend track
P<phase>-<nn>.<sub>  P6-18.2 Sub-task
```

IDs are **permanent and never reused**. A dropped task keeps its ID with status `DROPPED` and a reason. A gap in numbering is a lost audit trail.

IDs are the join key across the repository: branch names (`fix/P3-12-trusted-client-address`), commit subjects, `MEMORY/records/` file names, `MEMORY/specs/` file names, and `PROGRESS.md`.

**Retrospective IDs.** Tasks in the *Delivered* section of each phase file were numbered on 2026-09-13 to describe work already done. They have no individual spec or record. Do not create records for them after the fact; the phase summaries in `MEMORY/records/` cover them, labelled as reconstructed.

## 2. Status Values

| Status | Meaning |
|---|---|
| `TODO` | Not started |
| `BLOCKED` | Cannot start. **The blocker is always named** — a task ID, a gate, an `OQ-nn`, or an external dependency (devices, an account, a person) |
| `SPEC` | The specification is being written; no implementation yet |
| `WIP` | Implementation in progress |
| `REVIEW` | Implementation complete; verification or review outstanding |
| `DONE` | The task DoD and the global DoD are met, **and** a MEMORY record exists |
| `DONE (retro)` | Delivered before this folder existed; evidence named, no per-task record |
| `DROPPED` | Deliberately abandoned; reason and an ADR required |

## 3. Card Anatomy

```markdown
### P3-12 — Take the client address from the trusted proxy

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P0 — security, open, high likelihood |
| **Depends on** | — |
| **Blocked by** | — |
| **Plan refs** | docs/SECURITY/02 §4, docs/PLAN/15 §9, docs/PLAN/23 worked example |
| **Spec required** | Yes — touches authentication and attendance evidence |
| **Surface** | backend, ops |
| **Size** | M |

**Goal** — one sentence: the observable outcome.

**Steps** — the ordered sequence, each step leaving the system working.

**Definition of Done** — checkable conditions.

**Abuse cases to test** — scenario ids from docs/SECURITY/02.
```

| Field | Meaning |
|---|---|
| Priority | `P0` do next · `P1` before pilots (Gate A) · `P2` before paid GA · `P3` when convenient |
| Depends on | Task IDs that must be `DONE` first |
| Blocked by | Non-task blockers: a gate, an `OQ`, an external dependency |
| Plan refs | The authoritative documents. If code and these disagree, the documents win unless a deviation is raised (§7) |
| Spec required | See §5 |
| Surface | `backend`, `web`, `worker`, `auth`, `db`, `ops`, `docs` |
| Size | §8 |

## 4. Global Definition of Done

Inherited by every task. A card's own DoD is **in addition** to this.

1. **`pnpm verify` passes** — migration lint, lint, typecheck, tests, build. The output summary goes in the record. Until CI exists (`P0-09`), this is run locally and said so.
2. **Tests use real services** — PostgreSQL, Redis, NATS — never mocks of a data layer (`docs/PLAN/16` §1). A test that cannot run against a real service is **skipped and marked**, with the reason recorded in `docs/PLAN/13`.
3. **Every abuse case on the card has an automated test** that exercises the real request path, and was seen to fail against the unfixed code.
4. **Every new guard has been seen to fail** against a deliberate violation (ADR-020).
5. **A new endpoint** is in `ROUTE_MANIFEST` with module and permission, and in the `DOCS` map in `apps/web/src/lib/openapi.ts`.
6. **A new tenant table** has RLS enabled and forced, a policy, and composite tenant foreign keys where it references tenant data.
7. **Migrations are additive** and pass `pnpm lint:migrations`; anything that cannot run in a transaction goes to `migrations-online/`.
8. **Sensitive actions write an audit row**; nothing sensitive is logged (PII, tokens, passwords, coordinates).
9. **Screens meet `docs/UI-UX/14-UX-ACCEPTANCE-CRITERIA.md` §1** for every criterion they touch.
10. **Documentation that the change makes false is corrected in the same commit** — including `docs/PLAN/13`, the risk register (`docs/PLAN/22`), and scenario statuses in `docs/SECURITY/02`.
11. **A MEMORY record exists**; `MEMORY/MEMORY-INDEX.md` and `MEMORY/CHANGELOG.md` are updated; an ADR is written for any decision or deviation.
12. **`PROGRESS.md` and the phase file are updated** in the same commit.

## 5. When a Specification Is Required

`Spec required: Yes` for any task touching:

- authentication, sessions, tokens, or the client address
- authorization, roles, permissions, grants, menus, or subscriptions
- tenant isolation: RLS, tenant context, foreign keys across tenant data
- personal data: PII fields, unmasking, exports, documents, photos, location
- attendance evidence or trust scoring
- payroll, money, or statutory calculation
- the data model (a new table, or a column on a table with tenant data)
- a new external integration (payment, WhatsApp, email provider)

`No` for copy, styling, refactors with no behaviour change, documentation, and tests that add coverage without changing behaviour.

The spec lives at `MEMORY/specs/<task-id>-<slug>.md`, uses all 22 sections of `docs/PLAN/23`, and is committed before the implementation.

## 6. Definition of Ready

A task moves to `WIP` only when:

- every `Depends on` task is `DONE`;
- nothing in `Blocked by` remains;
- every document in `Plan refs` has been read **for this task**;
- the spec exists, if required;
- no open question in `BACKLOG.md` bears on it unanswered.

## 7. Deviation Protocol

`docs/` is reference documentation, not implementation output. When the code must differ from it:

1. **Stop.** Do not silently pick another approach.
2. Write an ADR in `MEMORY/DECISIONS.md`: the conflict, the options, the recommendation.
3. Add a `DV-nn` entry to `BACKLOG.md`.
4. Raise it with the user.
5. After a decision: implement, and state in the ADR whether the plan document is amended (a separate, deliberate edit).

**When the code is right and the document is wrong about the current state** — a stale claim, a miscounted figure — correct the document in the same commit and say so in the record. That is maintenance, not a deviation. Several such corrections were made while writing these documents; they are listed in `MEMORY/records/2026-09-13-documentation-set.md`.

## 8. Size

| Size | Meaning |
|---|---|
| `S` | Under half a day |
| `M` | One to two days |
| `L` | Several days; consider sub-tasks |
| `XL` | Must be split before `WIP` |

## 9. Branch, Commit, and Working Tree

- Branch: `feat/PF-02-mobile-navigation`, `fix/P3-12-trusted-client-address`, `chore/P0-09-ci-pipeline`.
- Commit subject: `P3-12: take the client address from the trusted proxy`.
- Commit body: the plan sections implemented; the tests added and run; any deviation with its ADR.
- **Stage files by explicit path.** Never `git add -A` or `git add .` — more than one agent may be working in the tree (`MEMORY/records/2026-09-13-concurrent-agent-commits.md`).
- **Check `git status` and `git log` before committing** for changes you did not make. If another tool's change is present, leave it out of your commit and mention it.
- One agent per working tree. Parallel agents use separate git worktrees.
