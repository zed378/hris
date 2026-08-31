import { withTenant, workerClient } from '@hrms/db';
import { log } from '@hrms/observability';
import {
  blindIndex,
  decryptPii,
  encryptPii,
  isEncryptedWithPrimaryKey,
  isIndexedWithPrimaryKey,
  UndecryptableError,
} from '@hrms/core/employee';

/**
 * Re-encrypts every PII column under the current primary key.
 *
 * The procedure this belongs to is in the runbook; what follows is why the code
 * has the shape it has.
 *
 * ## It rewrites rather than migrates
 *
 * There is no "rotation state" anywhere — no marker column, no progress table,
 * no resume cursor. Each row carries its own answer: `isEncryptedWithPrimaryKey`
 * asks the cipher whether the current key can read it, and only the rows that
 * say no are rewritten.
 *
 * That makes the job **idempotent and resumable for free**. Killed halfway, it
 * restarts and skips everything already done. Run twice on a finished database,
 * it writes nothing. Run before the key was rotated at all, it writes nothing.
 * A progress table would have added a second thing that can be wrong, and the
 * failure mode of stale progress state is resuming past rows that were never
 * actually converted.
 *
 * ## It never writes a value it could not read back
 *
 * Each row is decrypted, re-encrypted, and then **decrypted again and compared
 * against the original** before the update is issued. That looks paranoid for a
 * function that just called `encryptPii` — it is there because this job is the
 * one piece of code in the system capable of destroying data that exists nowhere
 * else. A national ID written under a corrupt key is not recoverable from a
 * backup taken after the run, and the mistake would surface months later, when
 * payroll needs a bank account number.
 *
 * ## One transaction per tenant, and a bounded batch inside it
 *
 * A single transaction over every employee of every tenant would hold row locks
 * for the duration of the rotation and block ordinary employee edits. A
 * transaction per tenant per batch keeps each lock window short, and a tenant
 * that fails does not roll back the tenants already converted — the same
 * reasoning as `runLeaveAccrual`.
 */

/** How many employees are converted per transaction. */
const BATCH_SIZE = 200;

export interface RotationSummary {
  tenants: number;
  scanned: number;
  /** Employees with at least one column rewritten. */
  rotated: number;
  /** Individual encrypted columns rewritten. */
  columns: number;
  /** Blind indexes recomputed under the current index key. */
  indexes: number;
  /**
   * Rows no key on the ring could read.
   *
   * Never silently skipped. It means either that `PII_ENCRYPTION_KEYS_OLD` was
   * cleared before the rotation finished, or that the row came from a different
   * database — and both are reasons to stop rather than continue.
   */
  unreadable: number;
  failed: number;
}

interface PiiRow {
  id: string;
  nationalIdEncrypted: string | null;
  nationalIdIndex: string | null;
  taxIdEncrypted: string | null;
  bankAccountEncrypted: string | null;
}

/**
 * Converts one value, verifying the result before it is returned.
 *
 * Returns `null` when the value is already under the primary key, so the caller
 * can tell "nothing to do" from "converted" without decrypting twice.
 */
function reEncrypt(value: string): string | null {
  if (isEncryptedWithPrimaryKey(value)) return null;

  const plain = decryptPii(value);
  const rewritten = encryptPii(plain);

  // The read-back. If this throws or disagrees, the update never happens.
  if (decryptPii(rewritten) !== plain) {
    throw new Error('Verifikasi gagal: nilai hasil enkripsi ulang tidak sama dengan aslinya.');
  }

  return rewritten;
}

export async function rotatePiiKeys(dryRun = false): Promise<RotationSummary> {
  /**
   * EVERY tenant, including churned and suspended ones — not
   * `active_tenant_ids()`, which every other job uses.
   *
   * The distinction is the difference between skipping work and destroying data.
   * Accrual for a departed tenant is pointless; skipping their PII means their
   * rows are still encrypted with the old key when the rotation withdraws it, and
   * from that moment nothing in the world can read them.
   *
   * Found by running this job against the development database, where it scanned
   * 1 employee out of the 7 holding encrypted values and reported success. The
   * other six belonged to CHURNED tenants.
   */
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.all_tenant_ids()
  `;

  const summary: RotationSummary = {
    tenants: tenants.length,
    scanned: 0,
    rotated: 0,
    columns: 0,
    indexes: 0,
    unreadable: 0,
    failed: 0,
  };

  for (const { tenant_id: tenantId } of tenants) {
    let offset = 0;

    for (;;) {
      let batch: PiiRow[];

      try {
        batch = await withTenant(
          tenantId,
          (tx) =>
            tx.employee.findMany({
              where: {
                OR: [
                  { nationalIdEncrypted: { not: null } },
                  { taxIdEncrypted: { not: null } },
                  { bankAccountEncrypted: { not: null } },
                ],
              },
              // Ordered by id so the window is stable across batches. Ordering by
              // anything editable — a name, an update timestamp — would let a
              // concurrent edit move a row between pages and skip it entirely.
              orderBy: { id: 'asc' },
              skip: offset,
              take: BATCH_SIZE,
              select: {
                id: true,
                nationalIdEncrypted: true,
                nationalIdIndex: true,
                taxIdEncrypted: true,
                bankAccountEncrypted: true,
              },
            }),
          { client: workerClient() },
        );
      } catch (error) {
        log.error({ scope: 'pii-rotation', tenantId, offset, error });
        summary.failed += 1;
        break;
      }

      if (batch.length === 0) break;
      summary.scanned += batch.length;
      offset += batch.length;

      for (const row of batch) {
        try {
          const data: Record<string, string> = {};

          for (const column of ['nationalIdEncrypted', 'taxIdEncrypted', 'bankAccountEncrypted'] as const) {
            const current = row[column];
            if (!current) continue;

            const rewritten = reEncrypt(current);
            if (rewritten) data[column] = rewritten;
          }

          /**
           * The blind index is recomputed only when the national ID had to be
           * decrypted anyway.
           *
           * It cannot be recomputed without the plaintext, and decrypting a row
           * purely to check its index would defeat the point of skipping rows
           * already converted. In the ordinary case — an encryption-key rotation
           * with the index key untouched — `isIndexedWithPrimaryKey` is true and
           * nothing is written.
           */
          if (row.nationalIdEncrypted && row.nationalIdIndex) {
            const plain = decryptPii(row.nationalIdEncrypted);
            if (!isIndexedWithPrimaryKey(plain, row.nationalIdIndex)) {
              data['nationalIdIndex'] = blindIndex(plain);
              summary.indexes += 1;
            }
          }

          const changed = Object.keys(data).length;
          if (changed === 0) continue;

          summary.rotated += 1;
          summary.columns += changed - (data['nationalIdIndex'] ? 1 : 0);

          if (dryRun) continue;

          await withTenant(tenantId, (tx) => tx.employee.update({ where: { id: row.id }, data }), {
            client: workerClient(),
          });
        } catch (error) {
          if (error instanceof UndecryptableError) {
            // Counted and logged with the row id, never skipped quietly. A single
            // unreadable row means the key ring is wrong, and continuing to the
            // end would report a successful rotation over a database that has
            // lost values.
            summary.unreadable += 1;
            log.error({ scope: 'pii-rotation', tenantId, employeeId: row.id, error });
            continue;
          }

          summary.failed += 1;
          log.error({ scope: 'pii-rotation', tenantId, employeeId: row.id, error });
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }
  }

  log.info({ scope: 'pii-rotation', dryRun, ...summary });
  return summary;
}
