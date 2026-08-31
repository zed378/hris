import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { rotatePiiKeys } from './pii-rotation.ts';

/**
 * Re-encrypts every PII column under the current primary key.
 *
 *   pnpm --filter @hrms/worker pii:rotate -- --dry-run
 *   pnpm --filter @hrms/worker pii:rotate
 *
 * The full procedure, including what to do before and after, is runbook §8. Do
 * not run this without having read it: the step that matters most is the backup
 * taken while the OLD key is still configured, because it is the only thing that
 * makes the rotation reversible.
 */
const dryRun = process.argv.includes('--dry-run');

if (!process.env['PII_ENCRYPTION_KEYS_OLD']) {
  // A warning rather than a refusal. Running with no old keys is exactly what a
  // verification pass after a completed rotation looks like, and it is also what
  // an operator who forgot to configure the ring looks like. The distinction is
  // theirs to make, so it is stated rather than decided.
  console.warn(
    'PII_ENCRYPTION_KEYS_OLD kosong. Bila rotasi belum selesai, baris yang masih ' +
      'memakai kunci lama akan terhitung sebagai TIDAK TERBACA, bukan dirotasi.',
  );
}

const summary = await rotatePiiKeys(dryRun);
console.log(JSON.stringify(summary, null, 2));
await disconnectAll();

/**
 * A non-zero exit when anything was unreadable or failed.
 *
 * Without it a rotation that could not read 400 rows still exits 0, and a
 * deployment pipeline treats "we lost access to four hundred national IDs" as
 * success. The summary is printed either way — the exit code is for the machine,
 * the JSON is for the person.
 */
if (summary.unreadable > 0 || summary.failed > 0) process.exit(1);
