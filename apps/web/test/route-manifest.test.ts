import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ROUTE_RULES, ADMIN_ROUTE_RULES } from '../src/lib/route-manifest.ts';

/**
 * Gerbang CI P7 — "tidak ada route gateway tanpa keputusan otorisasi eksplisit".
 *
 * Uji ini membandingkan dua sumber yang mudah menyimpang: berkas `route.ts` yang
 * benar-benar ada di disk, dan entri di `ROUTE_RULES`. Keduanya harus cocok
 * persis, ke dua arah.
 *
 * Arah pertama menangkap endpoint yang lupa didaftarkan — yaitu endpoint yang
 * tanpa sadar tidak dilindungi. Arah kedua menangkap entri usang, yang lebih
 * halus tetapi sama berbahayanya: manifest yang memuat route tak berwujud membuat
 * audit hak akses membaca sesuatu yang tidak mencerminkan sistem sungguhan.
 */

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/app');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** `src/app/api/auth/login/route.ts` → `/api/auth/login` */
function urlPathOf(file: string): string {
  const rel = relative(APP_DIR, dirname(file)).split(sep).join('/');
  return `/${rel}`;
}

/**
 * Menemukan metode HTTP yang diekspor sebuah berkas route.
 *
 * Mengenali `export const GET =` DAN `export function GET(` — termasuk versi
 * `async`-nya. Versi pertama hanya mengenali bentuk `const`, dan itu lubang
 * pada penjaganya sendiri: sebuah route yang ditulis
 *
 *     export function GET() { … }
 *
 * adalah handler Next.js yang sah sepenuhnya, tetapi tidak terlihat oleh
 * pemeriksaan cakupan manifes di bawah. Ia akan melewati P7 tanpa terdaftar,
 * melewati pemeriksaan pembungkus tanpa memakai defineRoute, dan bekerja
 * sempurna saat diuji manual — tanpa memeriksa izin apa pun.
 *
 * Ditemukan saat menambahkan endpoint kesehatan yang kebetulan ditulis dengan
 * bentuk `function`.
 */
function exportedMethods(source: string): string[] {
  return HTTP_METHODS.filter(
    (m) =>
      new RegExp(`export\\s+const\\s+${m}\\s*=`).test(source) ||
      new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\s*\\(`).test(source),
  );
}

const allRoutes = findRouteFiles(APP_DIR).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const path = urlPathOf(file);
  return exportedMethods(source).map((method) => ({
    routeId: `${method} ${path}`,
    path,
    file: relative(APP_DIR, file).split(sep).join('/'),
    source,
  }));
});

/**
 * Dua bidang, dua manifest, dan pemisahannya diperiksa di sini.
 *
 * Route di bawah `/admin` WAJIB berada di manifest admin dan memakai
 * `defineAdminRoute`. Sebuah jalur admin yang tanpa sadar memakai `defineRoute`
 * akan menerima token tenant — dan sejak saat itu setiap pengguna mana pun
 * memegang kunci ke control plane (P11).
 */
const adminRoutes = allRoutes.filter((r) => r.path.startsWith('/admin'));
const tenantRoutes = allRoutes.filter((r) => !r.path.startsWith('/admin'));

describe('ROUTE_RULES', () => {
  const discovered = tenantRoutes;

  it('menemukan handler untuk diperiksa', () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it('setiap handler yang ada di disk terdaftar di manifest', () => {
    const missing = discovered
      .filter((r) => !(r.routeId in ROUTE_RULES))
      .map((r) => `${r.routeId}  (${r.file})`);
    expect(missing).toEqual([]);
  });

  it('setiap entri manifest punya handler yang berwujud', () => {
    const ids = new Set(discovered.map((r) => r.routeId));
    const orphaned = Object.keys(ROUTE_RULES).filter((id) => !ids.has(id));
    expect(orphaned).toEqual([]);
  });

  it('setiap handler dibungkus defineRoute atau definePublicRoute', () => {
    // Handler yang mengekspor fungsi mentah melewati seluruh rantai guard.
    // Ia akan bekerja sempurna saat diuji manual, dan tidak memeriksa apa pun.
    const unwrapped = discovered
      .filter((r) => !/define(Public)?Route\(/.test(r.source))
      .map((r) => r.file);
    expect([...new Set(unwrapped)]).toEqual([]);
  });

  it('sifat publik di manifest cocok dengan pembungkus di handler', () => {
    const mismatched: string[] = [];
    for (const route of discovered) {
      const rule = ROUTE_RULES[route.routeId];
      if (!rule) continue;
      const method = route.routeId.split(' ')[0]!;
      const usesPublic = new RegExp(
        `export\\s+const\\s+${method}\\s*=\\s*definePublicRoute\\(`,
      ).test(route.source);
      if ((rule.public === true) !== usesPublic) {
        mismatched.push(`${route.routeId}: manifest public=${rule.public === true}, handler public=${usesPublic}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('setiap route menunjuk modul yang dikenal', () => {
    const KNOWN = ['core', 'iam', 'employee', 'attendance', 'leave', 'payroll'];
    const unknown = Object.entries(ROUTE_RULES)
      .filter(([, rule]) => !KNOWN.includes(rule.module))
      .map(([id, rule]) => `${id} → ${rule.module}`);
    expect(unknown).toEqual([]);
  });

  it('jalur publik yang dapat ditebak dibatasi laju', () => {
    // Login tanpa batas laju membuat kunci akun per pengguna berbalik menjadi
    // senjata: seluruh karyawan satu perusahaan dapat dikunci dari luar.
    // Endpoint kesehatan dikecualikan, dan alasannya bukan kelonggaran:
    // orkestrator memanggilnya setiap sepuluh sampai tiga puluh detik dari
    // alamat yang sama. Membatasi lajunya akan membuat kontainer yang sehat
    // dilaporkan gagal, lalu direstart — kegagalan yang diciptakan sendiri oleh
    // penjagaan yang salah tempat.
    //
    // JWKS dikecualikan atas alasan yang sama, dan taruhannya lebih besar.
    // Setelah auth dipisah (PLAN/14 tahap 6), backend dan worker mengambil kunci
    // publik dari sini untuk memverifikasi SETIAP token. Beberapa service di
    // belakang satu NAT terlihat sebagai satu alamat, sehingga batas laju di
    // sini berarti kegagalan mengambil kunci — dan kegagalan mengambil kunci
    // berarti seluruh token ditolak. Dokumennya statis, kecil, dan di-cache
    // lima menit; risiko penyalahgunaannya jauh lebih kecil daripada risiko
    // memadamkan verifikasi sendiri.
    const INFRASTRUCTURE_ROUTES = [
      'GET /api/health',
      'GET /api/ready',
      'GET /api/.well-known/jwks.json',
    ];

    const unlimited = Object.entries(ROUTE_RULES)
      .filter(
        ([id, rule]) =>
          rule.public === true &&
          !rule.rateLimit &&
          !id.includes('logout') &&
          !INFRASTRUCTURE_ROUTES.includes(id),
      )
      .map(([id]) => id);
    expect(unlimited).toEqual([]);
  });

  it('tidak ada route tenant yang berada di bawah /admin', () => {
    expect(Object.keys(ROUTE_RULES).filter((id) => id.includes('/admin'))).toEqual([]);
  });
});

describe('ADMIN_ROUTE_RULES', () => {
  it('menemukan handler admin untuk diperiksa', () => {
    expect(adminRoutes.length).toBeGreaterThan(0);
  });

  it('setiap handler admin terdaftar di manifest admin', () => {
    const missing = adminRoutes
      .filter((r) => !(r.routeId in ADMIN_ROUTE_RULES))
      .map((r) => `${r.routeId}  (${r.file})`);
    expect(missing).toEqual([]);
  });

  it('setiap entri manifest admin punya handler yang berwujud', () => {
    const ids = new Set(adminRoutes.map((r) => r.routeId));
    expect(Object.keys(ADMIN_ROUTE_RULES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('handler admin TIDAK PERNAH memakai guard tenant', () => {
    // Gerbang terpenting dalam berkas ini. `defineRoute` menerima token dengan
    // audience `hrms-tenant`; memakainya pada jalur admin berarti setiap pengguna
    // tenant mana pun dapat memanggil endpoint control plane.
    const leaky = adminRoutes
      .filter((r) => /\bdefine(Public)?Route\(/.test(r.source))
      .map((r) => r.file);
    expect(leaky).toEqual([]);
  });

  it('setiap handler admin dibungkus guard admin', () => {
    const unwrapped = adminRoutes
      .filter((r) => !/defineAdminRoute\(|definePublicAdminRoute\(/.test(r.source))
      .map((r) => r.file);
    expect([...new Set(unwrapped)]).toEqual([]);
  });

  it('handler tenant TIDAK PERNAH memakai guard admin', () => {
    const leaky = tenantRoutes
      .filter((r) => /define(Public)?AdminRoute\(/.test(r.source))
      .map((r) => r.file);
    expect(leaky).toEqual([]);
  });
});
