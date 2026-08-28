import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Kebijakan cache service worker (DoD Fase 3).
 *
 * Butir DoD-nya berbunyi: "Endpoint dashboard dan data sensitif tidak pernah
 * masuk Cache Storage — diverifikasi uji otomatis."
 *
 * Uji ini menjalankan `public/sw.js` YANG SEBENARNYA di dalam konteks VM dengan
 * global service worker yang dipalsukan. Menyalin logikanya ke dalam berkas uji
 * akan menguji salinan, bukan yang dikirim — dan salinan itu akan berbeda dari
 * aslinya pada perubahan pertama yang lupa disalin.
 *
 * Yang dijaga bukan kerapian. Cache Storage bertahan setelah tab ditutup,
 * setelah logout, dan dapat dibaca skrip mana pun yang berjalan di origin yang
 * sama. Satu balasan API yang tersimpan di sana adalah data kepegawaian yang
 * tertinggal di perangkat bersama — ponsel gudang yang dipakai bergantian tiga
 * shift, komputer resepsionis, tablet di ruang rapat.
 */

const SW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/sw.js',
);

interface FetchEvent {
  request: Request;
  respondWith: (response: unknown) => void;
}

type FetchHandler = (event: FetchEvent) => void;

/** Memuat sw.js sungguhan dan mengembalikan handler `fetch`-nya. */
function loadServiceWorker(): { onFetch: FetchHandler; cachePuts: string[] } {
  const source = readFileSync(SW_PATH, 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();

  // Setiap `cache.put` dicatat. Inilah yang membuktikan sesuatu benar-benar
  // masuk Cache Storage — bukan sekadar bahwa handler tidak melempar.
  const cachePuts: string[] = [];

  const fakeCache = {
    put: (request: Request | string, _response: unknown) => {
      cachePuts.push(typeof request === 'string' ? request : request.url);
      return Promise.resolve();
    },
    add: () => Promise.resolve(),
    match: () => Promise.resolve(undefined),
  };

  const sandbox = {
    self: {
      location: new URL('https://hrms.test/'),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
      registration: { pushManager: { getSubscription: () => Promise.resolve(null) } },
    },
    caches: {
      open: () => Promise.resolve(fakeCache),
      match: () => Promise.resolve(undefined),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: () => Promise.resolve(new Response('ok')),
    Response,
    Request,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  };

  runInNewContext(source, sandbox);

  const onFetch = listeners.get('fetch');
  if (!onFetch) throw new Error('sw.js tidak mendaftarkan handler fetch');

  return { onFetch: onFetch as FetchHandler, cachePuts };
}

/**
 * Menjalankan handler untuk satu permintaan.
 *
 * `intercepted` menjadi true bila service worker mengambil alih permintaannya.
 * Permintaan yang TIDAK diambil alih diteruskan peramban apa adanya — dan itulah
 * yang dituntut untuk jalur sensitif: bukan "di-cache dengan hati-hati",
 * melainkan tidak disentuh sama sekali.
 */
function dispatch(
  onFetch: FetchHandler,
  url: string,
  init: { mode?: RequestMode; headers?: Record<string, string>; method?: string } = {},
): { intercepted: boolean } {
  let intercepted = false;

  const request = new Request(url, {
    method: init.method ?? 'GET',
    ...(init.headers ? { headers: init.headers } : {}),
  });
  // `mode` bersifat hanya-baca pada Request, jadi dipasang di atasnya.
  Object.defineProperty(request, 'mode', { value: init.mode ?? 'no-cors' });

  onFetch({
    request,
    respondWith: () => {
      intercepted = true;
    },
  });

  return { intercepted };
}

describe('service worker tidak menyentuh jalur sensitif', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('melewatkan seluruh endpoint API', () => {
    // Termasuk yang belum ada. Penjagaan berbasis awalan `/api/` menutup
    // endpoint yang ditambahkan fase berikutnya tanpa ada yang perlu ingat
    // memperbarui daftarnya.
    //
    // Sebagian diuji dengan `mode: 'navigate'`, dan itu disengaja. Permintaan
    // `cors` memang tidak pernah diambil alih handler ini — sehingga menguji
    // API hanya dengan `cors` akan LULUS meski penjaga `NEVER_CACHE` dihapus
    // seluruhnya. Uji yang lulus karena alasan yang salah tidak menjaga apa pun.
    //
    // `navigate` ke jalur API bukan skenario karangan: membuka URL ekspor
    // langsung di tab baru menghasilkan persis permintaan itu.
    for (const path of [
      '/api/dashboard',
      '/api/employees',
      '/api/payroll/payslips',
      '/api/attendance/records',
      '/api/tenant/export',
      '/api/modul-yang-belum-ada',
    ]) {
      for (const mode of ['cors', 'navigate'] as const) {
        const { intercepted } = dispatch(sw.onFetch, `https://hrms.test${path}`, { mode });
        expect(intercepted, `${path} (${mode}) tidak boleh disentuh service worker`).toBe(
          false,
        );
      }
    }
  });

  it('melewatkan bidang admin sepenuhnya', () => {
    // Bidang admin bukan PWA (dokumen 11). Satu halamannya yang ter-cache di
    // perangkat berarti antarmuka control plane tertinggal di sana.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/admin/tenants', {
      mode: 'navigate',
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan halaman yang memuat kredensial', () => {
    for (const path of ['/login', '/reset-password', '/accept-invitation']) {
      const { intercepted } = dispatch(sw.onFetch, `https://hrms.test${path}`, {
        mode: 'navigate',
      });
      expect(intercepted, `${path} tidak boleh di-cache`).toBe(false);
    }
  });

  it('melewatkan permintaan yang membawa Authorization, apa pun jalurnya', () => {
    // Penjagaan kedua, dan yang paling penting: ia menutup jalur yang BELUM
    // ADA. Halaman data yang ditambahkan kelak tidak akan otomatis ter-cache
    // hanya karena tidak ada yang ingat memperbarui daftar NEVER_CACHE.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/laporan-baru', {
      mode: 'navigate',
      headers: { authorization: 'Bearer eyJ...' },
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan metode selain GET', () => {
    // POST yang ter-cache akan memutar ulang tindakan, bukan menampilkan data.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/api/attendance/punch', {
      method: 'POST',
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan origin lain', () => {
    const { intercepted } = dispatch(sw.onFetch, 'https://pihak-ketiga.test/skrip.js', {
      mode: 'cors',
    });
    expect(intercepted).toBe(false);
  });
});

describe('service worker menangani yang memang boleh', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('mengambil alih navigasi halaman aplikasi', () => {
    // Inilah gunanya PWA: halaman presensi tetap terbuka saat jaringan hilang.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/attendance/punch', {
      mode: 'navigate',
    });
    expect(intercepted).toBe(true);
  });

  it('mengambil alih aset statis berversi', () => {
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/_next/static/chunk-abc.js', {
      mode: 'no-cors',
    });
    expect(intercepted).toBe(true);
  });

  it('tidak menyimpan apa pun ke cache saat menangani navigasi', () => {
    // Navigasi memakai network-first dan hanya MEMBACA cache sebagai cadangan.
    // Menuliskannya akan membuat halaman data kemarin bertahan di perangkat.
    dispatch(sw.onFetch, 'https://hrms.test/employees', { mode: 'navigate' });
    expect(sw.cachePuts).toEqual([]);
  });
});

describe('daftar aset kerangka', () => {
  it('tidak memuat satu pun jalur data', () => {
    // `SHELL_ASSETS` di-cache saat pemasangan, tanpa melewati handler fetch —
    // sehingga penjagaan di atas tidak berlaku untuknya. Satu jalur data yang
    // masuk daftar itu akan ter-cache sebelum ada yang sempat menolaknya.
    const source = readFileSync(SW_PATH, 'utf8');
    const match = /const SHELL_ASSETS = \[([^\]]*)\]/.exec(source);
    expect(match, 'SHELL_ASSETS tidak ditemukan di sw.js').not.toBeNull();

    const assets = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);

    for (const asset of assets) {
      expect(asset.startsWith('/api/'), `${asset} adalah jalur API`).toBe(false);
      expect(asset.startsWith('/admin/'), `${asset} adalah jalur admin`).toBe(false);
      expect(asset.startsWith('/login'), `${asset} memuat kredensial`).toBe(false);
    }
  });
});
