import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { runContractReminders } from './contract-reminders.ts';

/**
 * Menjalankan pemindaian pengingat kontrak satu kali, lalu keluar.
 *
 * Berguna untuk dua hal: memverifikasinya saat pengembangan, dan menjalankannya
 * dari cron eksternal bila kelak worker jangka panjang tidak dipakai.
 *
 *   node --experimental-transform-types apps/worker/src/run-reminders-once.ts
 */
const result = await runContractReminders();
console.log(JSON.stringify(result));
await disconnectAll();
