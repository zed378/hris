import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll } from '@hrms/db';
import { runLeaveCarryOver } from './leave-carry-over.ts';

/**
 * Menutup satu tahun cuti, lalu keluar.
 *
 * Tahunnya WAJIB disebut eksplisit, tidak diturunkan dari tanggal hari ini.
 * Job yang menebak tahunnya sendiri akan menutup tahun yang salah bila
 * dijalankan pada 31 Desember malam — dan itu justru malam yang paling mungkin
 * seseorang menjalankannya secara manual.
 *
 *   pnpm --filter @hrms/worker carry-over 2026
 */
const year = Number(process.argv[2]);

if (!Number.isInteger(year) || year < 2000 || year > 2100) {
  console.error('Sebutkan tahun yang akan ditutup, mis.: pnpm --filter @hrms/worker carry-over 2026');
  process.exit(1);
}

const summary = await runLeaveCarryOver(year);
console.log(`Penutupan tahun ${year}:`, JSON.stringify(summary));
await disconnectAll();
