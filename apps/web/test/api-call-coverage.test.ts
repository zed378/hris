import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST } from '../src/lib/route-manifest.ts';

/**
 * Setiap panggilan API dari layar harus punya endpointnya.
 *
 * Kelas kegagalan yang paling sunyi dari yang dijaga repositori ini. Layar
 * memanggil endpoint lewat string; TypeScript tidak melihat hubungannya dengan
 * berkas `route.ts` mana pun. Jalur yang salah ketik — atau yang endpoint-nya
 * pernah ada lalu dipindahkan — menghasilkan **404 yang ditelan penanganan galat
 * layarnya sendiri**, dan yang terlihat pengguna hanyalah daftar yang tidak
 * pernah terisi.
 *
 * Kegagalan yang persis begitu sudah pernah terjadi di sini: tautan ekspor
 * berupa `<a href>` biasa yang selalu menghasilkan 401, dan tidak terlihat
 * sebagai galat oleh siapa pun sampai ada yang benar-benar mencoba mengunduh.
 *
 * Dibaca dari SUMBER — sistem berkas dan manifes — bukan dari daftar yang
 * ditulis ulang di sini.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Penanda satu segmen dinamis, apa pun bentuk aslinya. */
const DYN = ':dyn';

/**
 * Menyeragamkan jalur agar dapat dibandingkan dengan pola manifes.
 *
 * Dua bentuk interpolasi diperlakukan berbeda, dan pembedaannya adalah seluruh
 * ketelitian fungsi ini:
 *
 *   - `${...}` yang MENGISI satu segmen penuh adalah parameter jalur —
 *     `/api/leave/requests/${id}/decision` — dan menjadi `:dyn`.
 *   - `${...}` yang menempel pada segmen literal adalah akhiran atau query —
 *     `/api/employees/${id}/documents${archived ? '?a=1' : ''}` — dan seluruh
 *     sisanya dibuang.
 *
 * Versi pertama memperlakukan keduanya sama, dan `documents${...}` menjadi
 * `:dyn` sehingga kata "documents" hilang dari jalurnya. Positif palsu seperti
 * itu jauh lebih berbahaya daripada negatif palsu: uji yang menuduh kode yang
 * benar akan dimatikan orang, bersama seluruh penjagaannya.
 */
function normalisePath(raw: string): string {
  // Segmen penuh lebih dulu, selagi batas `/`-nya masih utuh.
  const withParams = raw.replace(/\/\$\{[^}]*\}(?=\/|$)/g, `/${DYN}`);

  // Sisa interpolasi apa pun adalah akhiran; query string juga dibuang.
  const cut = Math.min(
    ...[withParams.indexOf('${'), withParams.indexOf('?')]
      .filter((i) => i >= 0)
      .concat([withParams.length]),
  );

  return withParams.slice(0, cut);
}

interface UiCall {
  method: string;
  path: string;
  file: string;
}

function uiCalls(): UiCall[] {
  const out: UiCall[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Berkas di bawah `api/` ADALAH endpoint-nya, bukan pemanggilnya.
        if (entry.name !== 'api') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;

      const source = readFileSync(full, 'utf8');
      // Kutip penutup harus sejenis dengan pembukanya. Pola yang menerima
      // ketiganya akan berhenti pada kutip yang berada DI DALAM `${...}` —
      // kesalahan yang memotong jalur di tengah dan menuduhnya tidak terdaftar.
      const pattern =
        /api\(\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")\s*(?:,\s*\{([^}]*))?/g;

      for (const match of source.matchAll(pattern)) {
        const raw = match[1] ?? match[2] ?? match[3] ?? '';
        if (!raw.startsWith('/api/')) continue;

        out.push({
          method: /method:\s*'(\w+)'/.exec(match[4] ?? '')?.[1] ?? 'GET',
          path: normalisePath(raw),
          file: full.slice(ROOT.length + 1),
        });
      }
    }
  };

  walk(join(ROOT, 'src/app'));
  return out;
}

/** Pola manifes, dengan segmen dinamis apa pun namanya disamakan. */
function manifestPatterns(): Set<string> {
  const out = new Set<string>();

  for (const key of Object.keys(ROUTE_MANIFEST)) {
    const [method, path] = key.split(' ');
    if (!method || !path?.startsWith('/api/')) continue;

    // `[id]`, `[docId]`, `[key]` — namanya tidak menentukan apa pun.
    const normalised = path
      .split('/')
      .map((segment) => (segment.startsWith('[') ? DYN : segment))
      .join('/');

    out.add(`${method} ${normalised}`);
  }

  return out;
}

describe('panggilan API dari layar', () => {
  const calls = uiCalls();

  it('ditemukan', () => {
    // Penjaga terhadap regex yang berhenti cocok setelah gaya penulisan
    // berubah. Nol panggilan berarti uji di bawah lulus tanpa memeriksa apa pun.
    expect(calls.length).toBeGreaterThan(30);
  });

  it('seluruhnya punya endpoint di manifes', () => {
    const known = manifestPatterns();

    const hilang = [
      ...new Set(
        calls
          .filter((call) => !known.has(`${call.method} ${call.path}`))
          .map((call) => `${call.method} ${call.path} (${call.file})`),
      ),
    ];

    expect(hilang, `panggilan tanpa endpoint: ${hilang.join(', ')}`).toEqual([]);
  });
});
