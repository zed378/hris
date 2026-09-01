import type { TenantClient } from '@hrms/db';
import { updateEmployee, EmployeeError, type ActorContext } from './employees.ts';
import { MaskedValueError, InvalidIdentifierError } from './pii.ts';

/**
 * Mass editing from an Excel-like grid (PLAN/12 F2, risk R6).
 *
 * Risk R6 says it plainly: adoption fails if the UI feels more complex than
 * Excel. HR who now change fifty departments with one paste in a spreadsheet
 * will not move to a system that demands fifty forms — and no training changes
 * that.
 *
 * What makes this file not just a loop over `updateEmployee`:
 *
 * **Partial success is reported, not all-or-nothing.** One wrong cell on row 37
 * must not discard the 36 rows that were already correct. Someone who just
 * pasted two hundred rows from Excel has no way to repeat it, and an all-or-
 * nothing rejection would push them back to Excel — the very failure this
 * exists to prevent.
 *
 * For this reason each row runs in its own transaction. What is lost is the
 * atomicity of the whole operation; what is gained is that nobody's work
 * disappears. That trade is correct here because there is no invariant across
 * rows in employee data — changing one person's department does not depend on
 * what happens to another.
 */

export interface BulkChange {
  id: string;
  /** Version of the row the user saw when editing. Optimistic lock token. */
  version: number;
  fields: {
    employeeNumber?: string | undefined;
    fullName?: string | undefined;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    address?: string | null | undefined;
    bankName?: string | null | undefined;
    status?: 'PROBATION' | 'ACTIVE' | 'RESIGNED' | 'TERMINATED' | undefined;
    nationalId?: string | null | undefined;
    taxId?: string | null | undefined;
    bankAccount?: string | null | undefined;
  };
}

export interface BulkRowResult {
  id: string;
  ok: boolean;
  /** New version if successful, so the grid can edit again without reloading. */
  version: number | null;
  error: string | null;
}

export interface BulkUpdateResult {
  saved: number;
  failed: number;
  rows: BulkRowResult[];
}

/**
 * The row limit per request.
 *
 * Pastes from Excel can be any size, and a request saving five thousand rows
 * would hold a database connection for minutes while the user stares at a
 * screen that does not move. The client splits it into multiple requests; this
 * limit is what makes that split mandatory.
 */
export const MAX_BULK_ROWS = 200;

export class BulkTooLargeError extends Error {
  constructor(readonly received: number) {
    super(`Too many rows at once: ${received}. The limit is ${MAX_BULK_ROWS}.`);
    this.name = 'BulkTooLargeError';
  }
}

export async function bulkUpdateEmployees(
  runInTransaction: <T>(work: (tx: TenantClient) => Promise<T>) => Promise<T>,
  tenantId: string,
  changes: BulkChange[],
  ctx: ActorContext,
): Promise<BulkUpdateResult> {
  if (changes.length > MAX_BULK_ROWS) throw new BulkTooLargeError(changes.length);

  const rows: BulkRowResult[] = [];

  for (const change of changes) {
    // Rows with no changes are skipped without touching the database. The grid sends
    // what was pasted, and a paste almost always loads columns whose values are
    // the same — bumping `version` for those would make the next edit fail as
    // "changed by someone else" with nobody having changed anything.
    if (Object.keys(change.fields).length === 0) {
      rows.push({ id: change.id, ok: true, version: change.version, error: null });
      continue;
    }

    try {
      const result = await runInTransaction((tx) =>
        updateEmployee(tx, tenantId, change.id, change.version, change.fields, ctx),
      );
      rows.push({ id: change.id, ok: true, version: result.version, error: null });
    } catch (error) {
      rows.push({
        id: change.id,
        ok: false,
        version: null,
        error:
          error instanceof EmployeeError ||
          error instanceof MaskedValueError ||
          error instanceof InvalidIdentifierError
            ? error.message
            : error instanceof Error && error.message.includes('Unique constraint')
              ? 'Employee number already used by another person'
              : 'This row failed to save',
      });
    }
  }

  return {
    saved: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
  };
}
