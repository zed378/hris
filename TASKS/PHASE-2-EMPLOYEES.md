# Phase 2 — Employees and Excel Import

**Goal** (`docs/PLAN/12` §6): the first module used outside the team — replacing the employee spreadsheet with something that does not break when two people open it.

**State**: delivered (`docs/PLAN/13` §1). **Gate A has not been tested** — no pilot has imported their own file. One DoD item is only partly met: unmasking is audited on export, not on screen.

**Phase 2 DoD** (`docs/PLAN/12` §6):

- [ ] **Three pilot companies import ≥ 100 real employees from their own Excel files in < 30 minutes, unaided** — Gate A, `P2-09`
- [~] The export opens in Excel and matches row for row — `.xlsx` export built; row-for-row comparison not recorded
- [x] Import errors per row, correctable and re-uploadable
- [~] PII masked by permission; **unmasking recorded in the audit log** — masked everywhere; audited on export only (`P2-08`)

> **Gate A** — if three pilots cannot import on their own, fix that first. Do not go on to Phase 3.
> Phase 3 was built before Gate A was tested (`DV-01`, ADR-016).

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P2-01 | Employee CRUD, list, and AG Grid bulk edit | `/employees`, `/employees/grid`, `POST /api/employees/bulk` | DONE (retro) |
| P2-02 | Departments, positions, period-based employment with manager | `employee.department.created`, `employee.position.created` audit actions; `leave-approver.test.ts` | DONE (retro) |
| P2-03 | Contracts with end dates; reminders at 90 / 30 / 7 days | `packages/core/src/employee/contracts.ts`; `/employees/contracts` | DONE (retro) |
| P2-04 | Employee documents: type from magic bytes, archive not delete, expiry reminders, access logged | `documents.test.ts`, `document-kinds.test.ts` | DONE (retro) |
| P2-05 | PII encryption (AES-256-GCM, key ring, blind index), masking, key rotation job | `pii.test.ts`, `pii-rotation.test.ts`; `ops/RUNBOOK.md` §8 | DONE (retro) |
| P2-06 | Excel import: template, upload, column mapping, preview, per-row validation, commit or discard; no plaintext PII in staging | `import-schema.test.ts`, `import-pii.test.ts`; `/employees/import` | DONE (retro) |
| P2-07 | `.xlsx` export with `employee.exported` audit row recording whether it was unmasked | `packages/core/src/employee/export.ts` | DONE (retro) |

---

## Open

### P2-08 — Audit unmasked PII reads

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** |
| **Depends on** | — |
| **Plan refs** | `docs/PLAN/12` Phase 2 DoD, `docs/PLAN/00` §3.2 P5, `docs/PLAN/17` §9, `docs/SECURITY/02` §8(e), risk F11 |
| **Spec required** | Yes — personal data |
| **Surface** | backend, db |
| **Size** | M |

**Goal** — every response that returns an unmasked national ID, tax ID, or bank account writes an audit row naming the actor and the employees whose PII was revealed — and never the PII itself.

**Steps**
1. Spec: decide granularity. A list of 200 employees unmasked is one audit row listing 200 employee ids, not 200 rows. Decide whether unmasking is **opt-in per request** (`?unmask=1`) so viewing a list does not unmask by default for holders of the permission — recommended, because it makes the audit row mean "chose to reveal".
2. Write the audit row inside the same transaction as the read, in `listEmployees` and `getEmployee` when `canUnmask` is used.
3. Store `before: null`, `after: { employeeIds, fields }` — no values (`packages/core/src/employee/employees.ts` already states the audit table holds no PII).
4. Update the employee list and detail pages if unmasking becomes opt-in.

**Definition of Done**
- An integration test against real PostgreSQL: a user with `employee.pii.unmask` requests unmasked detail → exactly one `employee.pii.unmasked` row with the employee id; a user without it → PII masked and no row.
- A test asserts the audit row contains no 16-digit NIK, no NPWP, and no account number.
- `docs/PLAN/17` §5 and §9, `docs/PLAN/21` §4, `docs/SECURITY/02` §8, `docs/SECURITY/03` D-6, risk F11 updated.

**Abuse cases to test** — `SECURITY/02` §8(e): HR bulk-unmasks every employee; the trail must show it.

### P2-09 — Gate A: three pilots import their own files

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P1 |
| **Depends on** | P0-10 (staging); PF-04 and PF-11 (refused state, first-run guidance) strongly recommended first |
| **Blocked by** | Three pilot companies |
| **Plan refs** | `docs/PLAN/12` §6 Gate A, `docs/UI-UX/02` Journey 1, `docs/UI-UX/14` R6 |
| **Spec required** | No |
| **Surface** | docs |
| **Size** | L |

**Goal** — observe three HR administrators, unaided, importing ≥ 100 employees each from their own Excel file on staging.

**Definition of Done**
- For each pilot: time taken, rows imported, errors hit, where they got stuck — in `MEMORY/records/`.
- Pass or fail against the gate, stated.
- Every point where a pilot got stuck becomes a task.
- Pilot data handled under a data processing agreement; nothing from it enters the repository.

### P2-10 — Delete employee documents after the retention period

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P3 |
| **Blocked by** | `OQ-07` — the legal retention period |
| **Plan refs** | `docs/PLAN/13` §5 Technical debt |
| **Spec required** | Yes — personal data, deletion |
| **Surface** | worker |
| **Size** | M |

**Goal** — a worker job that deletes the file and marks the row after the legally required period, in the same order photo retention already uses (file after row state, so no row points at a missing file unrecorded).
