import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Satu berkas .env di akar monorepo, bukan satu per paket. Dua salinan konfigurasi
// koneksi yang boleh berbeda adalah cara yang paling mudah untuk tanpa sengaja
// menjalankan migrasi ke basis data yang salah.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

/**
 * Konfigurasi Prisma CLI — migrasi, introspeksi, seed.
 *
 * Perhatikan koneksi yang dipakai: `DATABASE_URL` adalah role **owner**, dan hanya
 * dipakai oleh CLI. Runtime aplikasi memakai `DATABASE_URL_APP` (role `hrms_app`,
 * NOBYPASSRLS) yang dipasang di `src/client.ts`.
 *
 * Pemisahan ini bukan kerapian. Bila aplikasi berjalan sebagai owner, RLS akan
 * dilewati diam-diam pada tabel yang lupa diberi FORCE ROW LEVEL SECURITY — dan
 * kebocoran lintas-tenant tidak melempar galat, ia hanya menampilkan data orang lain.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --experimental-transform-types prisma/seed.ts',
  },
});
