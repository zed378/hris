import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST } from '../src/lib/route-manifest.ts';

/**
 * Menu harus menuju halaman yang ada, dan izin harus benar-benar ada.
 *
 * Dua kelas kegagalan yang sudah terjadi di proyek ini, keduanya tanpa satu pun
 * galat saat kompilasi maupun deploy.
 *
 * **Menu menuju halaman yang tidak ada.** Menu dirakit dari basis data, bukan
 * dari kode, sehingga TypeScript tidak dapat melihat hubungannya dengan berkas
 * `page.tsx`. Empat entri pernah tampil di sidebar selama berbulan-bulan menuju
 * 404: "Shift & Jadwal", "Pengguna", "Peran", dan "Jejak Audit". Yang terakhir
 * tiga di antaranya berarti pemilik tenant yang baru mendaftar tidak dapat
 * menambahkan satu orang pun ke perusahaannya.
 *
 * **Izin yang tidak ada di katalog.** `ROUTE_MANIFEST` menyebut kode izin
 * sebagai string. Satu huruf yang salah menghasilkan izin yang tidak dimiliki
 * siapa pun — sehingga endpoint-nya menolak SEMUA orang dengan 403, termasuk
 * pemilik tenant, dan pesannya berbunyi "Anda tidak memiliki hak akses" alih-alih
 * "izin ini tidak ada". Yang mengalaminya akan mencari kesalahan pada perannya.
 *
 * Keduanya dibaca dari SUMBER — berkas seed dan sistem berkas — bukan dari
 * daftar yang ditulis ulang di sini. Daftar yang ditulis ulang akan ikut basi
 * bersama yang dijaganya.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = readFileSync(join(ROOT, '../../packages/db/prisma/seed.ts'), 'utf8');

/** Jalur menu beserta izin yang menjaganya, dibaca dari seed. */
function menuEntries(): Array<{ path: string; permission: string | null }> {
  const entries: Array<{ path: string; permission: string | null }> = [];

  // Setiap entri menu menyebut `path: '/...'`; sebagian menyebut
  // `permissionCode: '...'` pada baris sebelumnya.
  const pattern = /permissionCode:\s*'([^']+)'[^}]*?path:\s*'(\/[^']+)'/g;
  for (const match of SEED.matchAll(pattern)) {
    entries.push({ permission: match[1]!, path: match[2]! });
  }

  // Entri tanpa izin (bila kelak ada) tetap ikut diperiksa keberadaan halamannya.
  for (const match of SEED.matchAll(/path:\s*'(\/[^']+)'/g)) {
    const path = match[1]!;
    if (!entries.some((e) => e.path === path)) entries.push({ path, permission: null });
  }

  return entries;
}

/** Kode izin yang didaftarkan seed. */
function seededPermissions(): Set<string> {
  const codes = new Set<string>();
  // Bentuknya `['modul', 'kode.izin', 'Keterangan'],`
  for (const match of SEED.matchAll(/\[\s*'[a-z]+',\s*'([a-z][a-z0-9._]+)',\s*'/g)) {
    codes.add(match[1]!);
  }
  return codes;
}

describe('menu', () => {
  const entries = menuEntries();

  it('ditemukan di seed', () => {
    // Penjaga terhadap regex yang berhenti cocok setelah seed diformat ulang.
    // Tanpa ini, uji di bawah akan LULUS dengan nol entri — lulus karena tidak
    // memeriksa apa pun.
    expect(entries.length).toBeGreaterThan(15);
  });

  it('setiap jalur menu punya halamannya', () => {
    const missing = entries
      .map((entry) => entry.path)
      .filter((path) => !existsSync(join(ROOT, 'src/app', path, 'page.tsx')));

    expect(missing, `menu menuju halaman yang tidak ada: ${missing.join(', ')}`).toEqual([]);
  });

  it('setiap izin penjaga menu ada di katalog', () => {
    const known = seededPermissions();
    const unknown = entries
      .map((entry) => entry.permission)
      .filter((code): code is string => !!code && !known.has(code));

    expect(unknown, `izin tidak dikenal: ${unknown.join(', ')}`).toEqual([]);
  });
});

describe('manifes rute', () => {
  it('setiap izin yang disebut ada di katalog', () => {
    // Satu huruf yang salah di sini menolak SEMUA orang dengan 403, termasuk
    // pemilik tenant — dan pesannya menyalahkan perannya, bukan kodenya.
    const known = seededPermissions();
    expect(known.size, 'katalog izin tidak terbaca dari seed').toBeGreaterThan(30);

    const unknown = Object.entries(ROUTE_MANIFEST)
      .map(([route, rule]) => ({ route, permission: (rule as { permission?: string }).permission }))
      .filter((entry) => entry.permission && !known.has(entry.permission))
      .map((entry) => `${entry.route} → ${entry.permission}`);

    expect(unknown, `izin tidak dikenal di manifes: ${unknown.join(', ')}`).toEqual([]);
  });
});
