# MEMORY/ — Change Records and Decision Log

`TASKS/` is what will be done. `MEMORY/` is what **was** done, and why it ended up that way.

The plan documents describe the intended system and the code describes the current one; neither explains how one became the other. Why does the punch refusal name four ways forward? Why is the leave balance locked with `FOR UPDATE` rather than an advisory lock? Why does `/api/metrics` answer `404` to a wrong token? The code shows the choice. Only a record shows the reason, and what was tried first.

Much of this system's reasoning already lives in unusually long code comments and commit messages. `MEMORY/` does not duplicate them — it indexes the decisions, records what the comments cannot (deviations, incidents, process), and becomes the primary record for everything built from 2026-09-13 onwards.

---

## Structure

| Path | Purpose |
|---|---|
| [`MEMORY-INDEX.md`](./MEMORY-INDEX.md) | One line per record, newest first. The entry point |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed and roughly when, coarser than the records |
| [`DECISIONS.md`](./DECISIONS.md) | Architecture Decision Records — choices the plan left open, and every deviation from it |
| [`records/`](./records/) | One file per completed task, phase, incident, or operational event |
| [`specs/`](./specs/) | Feature specifications written before implementation (`docs/PLAN/23`) |
| [`templates/`](./templates/) | The change record and phase summary templates |

---

## Reconstructed Versus Contemporaneous

This folder was created on **2026-09-13**, after most of the system was built (2026-08-18 to 2026-09-01). So two kinds of entry exist, and they are labelled:

| Kind | Label | Trust |
|---|---|---|
| **Contemporaneous** — written with the work | none | A first-hand account |
| **Reconstructed** — written afterwards from code, commit messages, `docs/PLAN/13`, and `docs/PLAN/14` §10 | `Reconstructed: yes` in the header, and *(reconstructed)* in the index | Accurate about **what** was built, with evidence. Weaker about **why**, where no comment or commit recorded it, and silent about what was tried and abandoned unless a commit said so |

A reconstructed record never invents a reason. Where the reason is not recorded anywhere, it says "not recorded".

The first commit (`49481e8`, 2026-08-18) already contained substantial code, so the git history does not show Phases 0–1 being built step by step. Reconstructed records say so rather than implying an order the history cannot support.

---

## What Gets a Record

- **Every task that reaches `DONE`** — global DoD item 11 in `TASKS/00-TASK-CONVENTIONS.md`. A task without a record is not done.
- **Every deviation** from `docs/PLAN/`, `docs/UI-UX/`, or `docs/SECURITY/` — as an ADR and a `DV-nn` backlog entry.
- **Decisions the plan left open.**
- **Phase completions** — from `templates/PHASE-SUMMARY-TEMPLATE.md`.
- **Operational events with lasting consequence** — a restore rehearsal, a key rotation, a load test, a pilot session, an incident.
- **Process incidents** — for example, two tools committing to the same working tree.

## What Does Not

- Work in progress.
- What the git history already says accurately. A record explains *why*.
- A restatement of a plan document. Link to it.
- **Personal data.** Pilot interviews, artefacts, and incidents are recorded without names, NIK, NPWP, bank accounts, photos, or coordinates.

---

## Writing a Record

1. Copy [`templates/CHANGE-RECORD-TEMPLATE.md`](./templates/CHANGE-RECORD-TEMPLATE.md).
2. Name it `records/YYYY-MM-DD-<task-id>-<slug>.md` (the date the record is written).
3. Fill every section. "Not applicable — because …" is an answer; a blank is not.
4. Add a line at the top of [`MEMORY-INDEX.md`](./MEMORY-INDEX.md).
5. Add a [`CHANGELOG.md`](./CHANGELOG.md) entry if the change is user-visible or operationally significant.
6. Add an ADR if a decision was made or a plan deviated from.
7. **Commit it with the code**, not afterwards. A record written a week later is a reconstruction.

## Writing an ADR

Use the format at the top of `DECISIONS.md`. The two sections that matter most are the easiest to skip:

- **Alternatives considered** — so a future reader can tell whether their idea was already evaluated.
- **Consequences** — including the bad ones. An ADR listing only benefits will not be trusted.

---

## Honesty Rules

A record is worth reading only if it can be trusted.

- **Record what happened, not what was supposed to happen.** If a test was skipped, say so and why. If a DoD item was waived, say which and who agreed.
- **Record failures.** A missed target, an abandoned approach, a guard that turned out to match nothing — the highest-value records in the folder.
- **Do not edit a record to look better.** Add a follow-up record. The audit log is append-only at the database level for the same reason.
- **Separate what was verified from what was inferred.** "Tested against a real PostgreSQL" and "should work" are different claims and are written differently.
- **Record open questions found during the work** in `TASKS/BACKLOG.md`, so they have a consequence.
- **When a document turns out to be wrong, say that it was wrong** — including documents written in this folder.
