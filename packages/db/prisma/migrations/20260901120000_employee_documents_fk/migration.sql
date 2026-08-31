-- =============================================================================
-- A tenant-aware foreign key for employee_documents (document 09 §2.2)
-- =============================================================================
--
-- `employee_documents.employee_id` has pointed at `employee.employees(id)` since
-- the table was created and nothing has ever enforced it. Its sibling
-- `employee_contracts` has had the constraint from the start, so this is an
-- omission rather than a decision — one found while building the expiry
-- reminders, where the scan had to read employees through a separate query
-- because Prisma did not know the two tables were related.
--
-- ## Why the key references the PAIR, not just the id
--
-- The obvious constraint — `FOREIGN KEY (employee_id) REFERENCES employees(id)`
-- — leaves a hole, and the hole was measured rather than reasoned about.
-- Connected as `hrms_app` with `app.tenant_id` set to the demo tenant, with that
-- single-column key in place, this insert SUCCEEDED:
--
--     INSERT INTO employee.employee_documents (tenant_id, employee_id, ...)
--     VALUES ('<demo tenant>', '<an employee of a DIFFERENT tenant>', ...);
--     -- INSERT 0 1
--
-- PostgreSQL performs referential integrity checks WITHOUT row level security.
-- That is deliberate on their part: a foreign key that could see only the visible
-- rows would report "no such row" for a row that plainly exists, and the
-- difference between those two answers is a covert channel for reading another
-- tenant's data. The consequence here is that RLS and the foreign key each check
-- something real and NEITHER checks this — RLS hides the employee, the key
-- confirms it exists, and the cross-tenant row is written.
--
-- Nothing in the application constructs such a row today. That is not a defence.
-- Every serious defect in this system so far has been silent, and this one is
-- quieter than most: the document is invisible from BOTH tenants afterwards —
-- filtered out of its owner's folder by `employee_id`, filtered out of the other
-- tenant's by RLS — while the FILE it points at sits in object storage holding
-- someone's identity card. Invisible from both sides reads like containment and
-- is really a leak nobody can find.
--
-- Referencing `(tenant_id, employee_id)` closes it at the database, regardless of
-- RLS, regardless of which role is connected, and regardless of what the
-- application believes about itself.
--
-- ## ON DELETE RESTRICT, where employee_contracts uses CASCADE
--
-- The difference is deliberate, and the codebase already decided it. Attendance
-- photo retention and `cleanupOrphanAttachments` both delete THE FILE FIRST and
-- the row second, for a stated reason: the reverse order leaves a file connected
-- to no record, so the next sweep never finds it again.
--
-- A cascade here is exactly that reverse order, performed by the database where
-- no sweep can intervene. Deleting an employee would silently drop every document
-- row and strand every file behind it. `RESTRICT` refuses instead, turning a
-- silent leak into an error message in front of whoever is doing the deleting.
-- Nothing in the application deletes an employee today, so this costs nothing now
-- and is here for the code that does not exist yet.
--
-- A contract row owns no file, so cascading one strands nothing.
--
-- ## On locks
--
-- The polite form of this migration is `ADD CONSTRAINT ... NOT VALID` followed by
-- `VALIDATE CONSTRAINT` in a SEPARATE transaction, so the table scan runs under
-- SHARE UPDATE EXCLUSIVE instead of ACCESS EXCLUSIVE (risk R33).
--
-- It is not available here. **Prisma runs every migration inside a transaction
-- and offers no way to opt out** — verified on 7.9.1, where `CREATE INDEX
-- CONCURRENTLY` fails with SQLSTATE 25001 and the `-- prisma-no-transaction`
-- marker (borrowed from other migration tools) is not recognised. Inside one
-- transaction the split buys nothing: the exclusive lock taken by the first
-- statement is held until commit, so the scan runs under it anyway.
--
-- So this takes the lock honestly rather than performing the appearance of
-- avoiding it. Both tables are small — one row per person, a handful of documents
-- each — and the scan is milliseconds. Recorded as debt in PLAN/13: a migration
-- that genuinely must run outside a transaction, on `punch_logs` or
-- `attendance_days`, will need a runner Prisma does not provide.
--
-- Checked for violations before writing this: zero documents without a matching
-- employee, and zero whose tenant disagrees with their employee's.

SET LOCAL lock_timeout = '3s';

-- The referenced pair must be unique. `id` is already the primary key, so every
-- existing row satisfies this the moment the index exists — it is for
-- PostgreSQL's benefit, not a new rule imposed on the data.
ALTER TABLE "employee"."employees"
  ADD CONSTRAINT "employees_tenant_id_id_key" UNIQUE ("tenant_id", "id");

ALTER TABLE "employee"."employee_documents"
  ADD CONSTRAINT "employee_documents_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "employee"."employees" ("tenant_id", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

COMMENT ON CONSTRAINT "employee_documents_tenant_id_employee_id_fkey"
  ON "employee"."employee_documents" IS
  'Tenant-aware on purpose. A single-column key to employees(id) passes for an '
  'employee of another tenant, because PostgreSQL runs referential integrity '
  'checks without row level security. Referencing the pair closes that.';
