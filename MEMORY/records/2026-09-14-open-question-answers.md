# Answers to OQ-01, OQ-03, OQ-11 — and OQ-05 Asked Again

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Task** | — (decisions by the user) |
| **Phase** | — |
| **Surface** | docs |
| **Author** | Claude Code (Claude Opus 5) |
| **Commits** | The commit adding this record |
| **Spec** | `MEMORY/specs/P6-18-api-documentation-access.md` moved to Reviewed |
| **Status** | Completed — documents updated; no code changed |
| **Reconstructed** | No |

---

## What Changed

The user answered three open questions. Each answer became an ADR, and every document that described the question as open, or depended on its outcome, was updated in the same commit. Two tasks were added, one question was raised, and one question was rewritten because the user did not understand it.

## The Answers, as Given

| Question | The user's answer (translated from Indonesian) | ADR |
|---|---|---|
| `OQ-01` — language of API error messages | "Use English for the system, responses, messages, debugging, and the rest. The frontend is fully Indonesian." | ADR-030 |
| `OQ-11` — API documentation secret header | "Do it as you suggested." | ADR-031 |
| `OQ-03` — SSO and a public API | "For now the gate is only in backend logic for multi-tenant access. Maybe SSO will be implemented in the future. There is no public API access." | ADR-032 |
| `OQ-05` — capacity assumptions | "I don't understand the direction of this question." | — (rewritten) |

## Interpretations Made

Recorded so the user can correct them; each is also stated in its ADR.

1. **`OQ-01`**: "frontend fully Indonesian" includes data the frontend displays from the database — seeded menu labels, leave-type and holiday names — so those stay Indonesian even though they are stored and served by the backend.
2. **`OQ-01`**: emails and push notifications reach users outside the frontend, so the answer does not settle them. Raised as `OQ-15` rather than decided either way. They are currently English.
3. **`OQ-01`**: "the frontend is Indonesian" implies the frontend must stop displaying server messages at all, not merely that the backend's messages switch language. Without that, the decision would put English on Indonesian pages.
4. **`OQ-03`**: "the gate is only in backend logic" was read as: authorization stays in-process inside the backend, and the separate auth service is not enabled. Combined with "maybe SSO later" and "no public API", this meets `docs/PLAN/14` §12 S8's own condition for stopping the split.

## Consequences Applied

| Area | Change |
|---|---|
| Tasks | `P6-24` added (English backend messages with a machine-readable `reason`); `PF-20` added (Indonesian message catalogue; never render a server message); `P6-18` unblocked with the design fixed; `PS-10`, `PS-11`, `PS-12` blocked by `DF-11` (SSO) |
| Backlog | `OQ-01`, `OQ-03`, `OQ-11` answered; `OQ-04`, `OQ-10` no longer needed; `OQ-05` rewritten as three plain questions with a default; `OQ-15` raised; `PG-02` narrowed; `DF-11`, `DF-12` added |
| Plan | `docs/PLAN/14` §13 annotated; `docs/PLAN/15` §6, §8, §10, §11; `docs/PLAN/17` §8, §9; `docs/PLAN/22` (F10 restated; S3 and S8 controlled) |
| Security | `docs/SECURITY/02` §10 notes the internal boundary exists only if the auth service is enabled |
| UI-UX | `00`, `06`, `11`, `13`, `14` — errors come from the frontend catalogue, never the server |
| Agents and README | `CLAUDE.md` and `AGENTS.md` rule 12 and stack; `docs/README.md` and `README.md` language notes |
| Memory | ADR-023 superseded; ADR-017 status updated; ADR-030–032; spec P6-18 Reviewed; pending table updated |

## Scope Measured for `OQ-01`

A rough search on 2026-09-14, to size the tasks rather than to be exact:

- about **237** Indonesian string literals in about **77** backend files (`apps/web/src/app/api`, `packages/core`, `packages/contracts`, `apps/auth`, `apps/worker`), excluding comment lines;
- about **30** places in the frontend rendering a server `message`;
- English user-facing strings in `apps/web/src/lib/push.ts` and the fallback in `session.tsx`;
- email and push templates already English.

`P6-24` measures precisely in its spec.

## Deviations from the Plan

`docs/PLAN/14` stops before its final stages — by the plan's own stated condition, so recorded as a decision (ADR-032), not a deviation.

## Tests Added

None — documentation only. `pnpm verify` not run; no code changed.

## Follow-Ups

- `OQ-05` and `OQ-15` await the user.
- `P6-24` needs its spec before work: the shape of `reason` and of validation `details`.

## What to Watch

- A new page rendering `error.message`, before `PF-20`'s test exists to refuse it.
- `apps/auth` and the broker seam rotting while unused — ADR-032 says remove them rather than leave them broken.
