import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { sealTotpSecrets } from '../src/platform/index.ts';

/**
 * Seals every plaintext superuser TOTP secret, and re-seals any written by a
 * demoted key (P6-14, runbook §8a).
 *
 *   pnpm --filter @hrms/core platform:seal-totp
 *
 * Needs `DATABASE_URL_PLATFORM` and `PLATFORM_ENCRYPTION_KEY`. Re-runnable: a
 * secret already sealed with the primary key is left alone.
 */
const summary = await sealTotpSecrets();
console.log(JSON.stringify(summary));
await disconnectAll();
