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

  /**
   * Browser security headers (P6-12, risk F5).
   *
   * Every directive is the narrowest the app works with, checked against what
   * the pages actually do:
   *
   * - `script-src 'unsafe-inline'`: the App Router streams its RSC payload in
   *   inline scripts. Removing it needs per-request nonces from middleware,
   *   which makes every page dynamic — a separate decision. So this CSP limits
   *   where script may load FROM; it does not stop an injected inline script.
   *   React's escaping remains the XSS defence.
   * - `'unsafe-eval'` only under `next dev`, for Fast Refresh. A production
   *   build does not use eval.
   * - `img-src blob:`: the punch page previews the captured photo through
   *   `URL.createObjectURL`. Without it the preview of the one photo every
   *   employee takes daily is blocked.
   * - No `https:` source anywhere: the app loads nothing from another origin.
   * - No `upgrade-insecure-requests`: on plain HTTP — a phone testing a LAN
   *   build — it rewrites every asset to an https URL that does not exist. HSTS
   *   enforces HTTPS where HTTPS is served.
   */
  async headers() {
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env['NODE_ENV'] === 'development' ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Redundant with `frame-ancestors 'none'` in browsers that read CSP;
          // kept for those that do not.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Ignored by browsers over plain HTTP, so local development is unaffected.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
