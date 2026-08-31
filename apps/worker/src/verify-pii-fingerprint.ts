import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll, withTenant, workerClient } from '@hrms/db';
import { decryptPii } from '@hrms/core/employee';

/**
 * A fingerprint over every decrypted PII value in the database.
 *
 * Its only purpose is verifying a key rotation. Comparing ciphertext before and
 * after proves nothing — the ciphertext is SUPPOSED to change, and a rotation
 * that quietly replaced every national ID with the string "undefined" would also
 * change it. What must be identical is the plaintext, and the plaintext must not
 * be written to a terminal to establish that.
 *
 * So each value is decrypted, hashed with its column and row id, and only the
 * digest of the whole set is printed. Equal digests before and after mean every
 * value survived; a different digest means at least one did not, without
 * disclosing which or what it was.
 *
 *   node --experimental-transform-types apps/worker/src/verify-pii-fingerprint.ts
 */
const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
  SELECT tenant_id FROM public.all_tenant_ids()
`;

const digest = createHash('sha256');
let rows = 0;
let values = 0;
let unreadable = 0;

for (const { tenant_id: tenantId } of tenants) {
  const employees = await withTenant(
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
        orderBy: { id: 'asc' },
        select: {
          id: true,
          nationalIdEncrypted: true,
          taxIdEncrypted: true,
          bankAccountEncrypted: true,
        },
      }),
    { client: workerClient() },
  );

  for (const employee of employees) {
    rows += 1;
    for (const column of ['nationalIdEncrypted', 'taxIdEncrypted', 'bankAccountEncrypted'] as const) {
      const stored = employee[column];
      if (!stored) continue;
      try {
        digest.update(`${employee.id}:${column}:${decryptPii(stored)}\n`);
        values += 1;
      } catch {
        unreadable += 1;
      }
    }
  }
}

console.log(JSON.stringify({ rows, values, unreadable, fingerprint: digest.digest('hex').slice(0, 32) }));
await disconnectAll();
