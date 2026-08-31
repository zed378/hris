import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { backfillWorkDates } from './workdate-backfill.ts';

/**
 * Repairs punch working dates written before the timezone fix.
 *
 *   pnpm --filter @hrms/worker workdate:backfill -- --dry-run
 *   pnpm --filter @hrms/worker workdate:backfill
 *
 * Run the dry pass first and read `daysLocked`: those are days inside a CLOSED
 * attendance period. Their punches are corrected either way, but their recap —
 * the figures payroll has already used — is not, and reconciling that is a
 * decision for a person, not for this job.
 */
const dryRun = process.argv.includes('--dry-run');

const summary = await backfillWorkDates(dryRun);
console.log(JSON.stringify(summary, null, 2));
await disconnectAll();

if (summary.failed > 0) process.exit(1);
