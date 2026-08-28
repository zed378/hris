import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { runLeaveAccrual } from './leave-accrual.ts';

/**
 * Menjalankan akrual cuti sekali, lalu keluar.
 *
 * Untuk cron di host bila worker jangka panjang tidak dipakai, dan untuk
 * memeriksa hasilnya secara manual:
 *
 *   pnpm --filter @hrms/worker accrual
 *   pnpm --filter @hrms/worker accrual 2026-08-28
 *
 * Tanggal boleh disebut — berbeda dari `carry-over`, yang tahunnya WAJIB
 * disebut. Alasannya berlawanan arah: menjalankan akrual pada tanggal hari ini
 * selalu benar dan idempoten, sedangkan menutup tahun pada tanggal yang salah
 * memindahkan saldo orang. Yang berbahaya bila ditebak wajib disebut; yang
 * aman bila ditebak boleh dikosongkan.
 */
const arg = process.argv[2];
const asOf = arg ? new Date(`${arg}T00:00:00.000Z`) : new Date();

if (Number.isNaN(asOf.getTime())) {
  console.error('Tanggal tidak valid. Format: YYYY-MM-DD');
  process.exit(1);
}

const summary = await runLeaveAccrual(asOf);
console.log(`Akrual per ${asOf.toISOString().slice(0, 10)}:`, JSON.stringify(summary));
await disconnectAll();
