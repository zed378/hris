import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// Next hanya membaca .env dari direktori aplikasi, sedangkan monorepo ini
// sengaja memakai satu berkas .env di akar — dua salinan konfigurasi koneksi
// yang boleh berbeda adalah cara termudah untuk menjalankan migrasi ke basis
// data yang salah.
//
// Berkas config ini dieksekusi di proses server Next, sehingga variabel yang
// dipasang di sini terlihat oleh route handler. Di produksi, variabel berasal
// dari lingkungan dan `override: false` memastikan .env tidak menimpanya.
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'),
  override: false,
  quiet: true,
});

const config: NextConfig = {
  // Paket workspace dikirim sebagai TypeScript sumber, bukan hasil build. Untuk
  // tim sebesar ini, menghapus langkah build antara adalah penghematan nyata:
  // satu perintah lebih sedikit yang bisa lupa dijalankan sebelum debugging.
  transpilePackages: ['@hrms/core', '@hrms/db', '@hrms/contracts'],
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2', 'pg'],
};

export default config;
