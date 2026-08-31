/* eslint-disable no-undef */

/**
 * Service worker HRMS (dokumen 11).
 *
 * Ditulis tangan, bukan dibangkitkan Workbox. Untuk cakupan sekecil ini —
 * satu app shell dan satu antrean luring — Workbox menambah satu lapisan
 * abstraksi yang harus dipahami sebelum seseorang dapat men-debug mengapa
 * sebuah request tidak masuk cache.
 *
 * ATURAN YANG MENGIKAT BERKAS INI
 *
 * 1. Data sensitif TIDAK PERNAH masuk Cache Storage. Slip gaji, dashboard,
 *    daftar karyawan, dan kasus rahasia hanya boleh ada di memori halaman
 *    (dokumen 11 §5.4). Cache Storage bertahan setelah logout dan dapat dibaca
 *    skrip mana pun di origin yang sama.
 *
 * 2. Token TIDAK PERNAH menyentuh cache. Access token hidup di memori halaman;
 *    refresh token adalah cookie httpOnly yang bahkan tidak terlihat dari sini.
 *
 * 3. Satu-satunya tulis luring adalah PRESENSI, karena hanya itu yang benar-benar
 *    terhalang jaringan (P16). Pengajuan cuti dapat menunggu; orang yang berdiri
 *    di gerbang pabrik pukul tujuh pagi tidak dapat.
 */

const VERSION = 'v1';
const SHELL_CACHE = `hrms-shell-${VERSION}`;

/**
 * Hanya kerangka aplikasi. Tidak ada satu pun endpoint data di sini.
 */
const SHELL_ASSETS = ['/', '/attendance/punch', '/manifest.webmanifest', '/icon-192.svg'];

/** Jalur yang tidak boleh masuk cache dalam keadaan apa pun. */
const NEVER_CACHE = [
  '/api/',
  '/admin/',
  '/login',
  '/reset-password',
  '/accept-invitation',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `addAll` gagal seluruhnya bila satu berkas gagal. Ditangani per berkas
      // supaya satu aset yang belum ada tidak membuat service worker gagal
      // dipasang sama sekali.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Dua penjagaan, dan keduanya diperlukan. Yang pertama menutup jalur yang
  // sudah diketahui; yang kedua menutup jalur yang belum ada — halaman data
  // yang ditambahkan fase berikutnya tidak akan otomatis ter-cache hanya karena
  // tidak ada yang ingat memperbarui daftar ini.
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.headers.get('authorization')) return;

  // Network-first untuk navigasi: aplikasi HR yang menampilkan data kemarin
  // lebih berbahaya daripada aplikasi yang menolak dibuka.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached ?? caches.match('/attendance/punch')),
      ),
    );
    return;
  }

  // Cache-first hanya untuk aset statis, yang berversi lewat nama berkasnya.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.endsWith('.svg')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});

/**
 * Pembersihan total saat logout.
 *
 * Dipicu halaman lewat postMessage. Ini yang mencegah data pengguna A terbaca
 * pengguna B di perangkat bersama — kasus yang lazim di ruang HR dan di pos
 * satpam (risiko R50).
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'HRMS_LOGOUT') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
  }
});

/**
 * Web Push (dokumen 11 §7).
 *
 * `userVisibleOnly: true` diwajibkan peramban dan sengaja tidak dilawan: push
 * senyap adalah kemampuan melacak kehadiran perangkat tanpa sepengetahuan
 * pemiliknya, dan tidak ada satu pun kebutuhan HRIS yang membenarkannya.
 *
 * Payload-nya sudah terenkripsi untuk perangkat ini — layanan push di antaranya
 * tidak dapat membacanya. Karena itu isinya tetap dijaga tipis: judul, satu
 * baris, dan tautan. **Tidak ada nominal gaji, tidak ada NIK, tidak ada alasan
 * cuti.** Notifikasi muncul di layar terkunci yang dapat dilihat siapa pun yang
 * kebetulan berada di dekat perangkat itu, dan enkripsi tidak menolong di sana.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // Payload yang tidak dapat diurai diabaikan diam-diam. Menampilkan
    // notifikasi berisi teks mentah akan membuat pengguna melihat pecahan JSON
    // di layar terkuncinya.
    return;
  }

  const title = payload.title;
  if (typeof title !== 'string' || title.length === 0) return;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/icon.svg',
      // Notifikasi ber-tag sama saling menimpa. Tiga pengajuan cuti yang
      // diputuskan berturut-turut menghasilkan tiga notifikasi; tiga percobaan
      // pengiriman untuk keputusan yang SAMA harus menghasilkan satu.
      tag: typeof payload.tag === 'string' ? payload.tag : 'hrms',
      renotify: false,
      data: { url: typeof payload.url === 'string' ? payload.url : '/' },
    }),
  );
});

/**
 * Klik notifikasi.
 *
 * Tab yang sudah terbuka DIFOKUSKAN, bukan ditimpa tab baru. Membuka tab kedua
 * pada aplikasi yang sudah berjalan akan meninggalkan dua sesi di perangkat yang
 * sama — dan pada perangkat bersama, tab yang terlupakan adalah sesi yang
 * tertinggal terbuka.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          void client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
