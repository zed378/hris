'use client';

/**
 * Antrean presensi luring (dokumen 11 §6).
 *
 * Satu-satunya tulis luring dalam sistem, dan itu disengaja (P16). Pengajuan
 * cuti dapat menunggu sampai ada sinyal; orang yang berdiri di gerbang pabrik
 * pukul tujuh pagi tanpa sinyal tidak dapat.
 *
 * TIDAK memakai Background Sync. Dukungannya tidak ada di iOS sama sekali, dan
 * membangun keandalan di atas API yang absen pada separuh perangkat pengguna
 * berarti membangun keandalan yang hanya terlihat bekerja saat diuji di Android.
 * Yang dipakai adalah pemicu berlapis: saat kembali online, saat halaman
 * terlihat lagi, dan saat aplikasi dibuka.
 *
 * Batas yang harus dinyatakan jujur (risiko R48): iOS menghapus penyimpanan
 * situs yang tidak dibuka selama tujuh hari. Antrean yang menumpuk selama
 * seminggu tanpa sinyal DAPAT HILANG. `navigator.storage.persist()` mengurangi
 * risikonya, dan pengguna diberi tahu bila permintaan itu ditolak.
 */

const DB_NAME = 'hrms-offline';
const DB_VERSION = 1;
const STORE = 'punch-queue';

export interface QueuedPunch {
  /**
   * Pemilik ketukan ini — id pengguna yang mengantrekannya.
   *
   * Wajib, dan alasannya adalah bug yang ditemukan saat menutup DoD Fase 3.
   *
   * Antrean luring SENGAJA bertahan setelah logout: ia milik perangkat, bukan
   * milik sesi, dan menghapusnya berarti membuang presensi yang belum sempat
   * terkirim milik orang yang baru saja keluar. Keputusan itu tetap benar.
   *
   * Yang salah adalah akibatnya bila tidak ada penanda pemilik. Server
   * menurunkan `employeeId` dari SESI, bukan dari isi ketukan. Pada perangkat
   * bersama — ponsel gudang yang dipakai tiga shift, komputer pos satpam —
   * urutannya menjadi:
   *
   *   1. A mengetuk saat jaringan mati. Ketukannya masuk antrean.
   *   2. A keluar. Antrean bertahan, sesuai rancangan.
   *   3. B masuk. Pemicu sinkronisasi berjalan.
   *   4. Ketukan A terkirim dengan token B, dan tercatat sebagai kehadiran B.
   *
   * Presensi A lenyap; B menerima kehadiran yang tidak ia lakukan. Tidak ada
   * galat yang muncul, dan keduanya baru terlihat saat slip gaji terbit.
   */
  ownerUserId: string;
  /** Dibangkitkan SEBELUM pengiriman pertama. Kunci idempotensi di server. */
  dedupeKey: string;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';
  punchedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  photoKey: string | null;
  deviceInfo: string | null;
  queuedAt: string;
  attempts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'dedupeKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function enqueuePunch(punch: QueuedPunch): Promise<void> {
  await withStore('readwrite', (store) => store.put(punch));
}

export async function queuedPunches(): Promise<QueuedPunch[]> {
  return withStore('readonly', (store) => store.getAll() as IDBRequest<QueuedPunch[]>);
}

export async function dequeuePunch(dedupeKey: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(dedupeKey));
}

export interface FlushResult {
  sent: number;
  failed: number;
  /** Milik pengguna saat ini yang masih tertahan. */
  remaining: number;
  /** Milik pengguna lain di perangkat yang sama. */
  otherUsers: number;
}

/**
 * Mengirim seluruh antrean.
 *
 * Ketukan yang ditolak server dengan galat permanen (4xx selain 401/429) dibuang
 * dari antrean. Menyimpannya selamanya berarti antrean yang tidak pernah kosong
 * dan indikator "belum terkirim" yang tidak pernah hilang — sehingga pengguna
 * berhenti memercayainya.
 *
 * Aman dijalankan dua kali bersamaan: server memakai `dedupeKey` sebagai kunci
 * unik, sehingga pengiriman ganda menghasilkan satu baris dan balasan sukses.
 */
export async function flushQueue(
  send: (punch: QueuedPunch) => Promise<Response>,
  /**
   * Pengguna yang sedang masuk. Hanya ketukan miliknya yang dikirim.
   *
   * Ketukan milik orang lain DITINGGALKAN di antrean, bukan dibuang: pemiliknya
   * mungkin masuk lagi nanti di perangkat yang sama, dan presensinya masih
   * dapat terkirim. Membuangnya berarti menghilangkan kehadiran seseorang
   * karena orang lain kebetulan memakai perangkat itu lebih dulu.
   */
  currentUserId: string,
): Promise<FlushResult> {
  const queue = await queuedPunches();
  let sent = 0;
  let failed = 0;

  for (const punch of queue) {
    // Milik orang lain — dilewati diam-diam, tanpa dihitung gagal. Ia bukan
    // kegagalan; ia sekadar bukan giliran ketukan ini.
    if (punch.ownerUserId !== currentUserId) continue;

    try {
      const response = await send(punch);

      if (response.ok) {
        await dequeuePunch(punch.dedupeKey);
        sent += 1;
        continue;
      }

      // 401 dan 429 bersifat sementara: sesi dapat disegarkan, batas laju akan
      // reda. Ketukan tetap di antrean.
      if (response.status === 401 || response.status === 429 || response.status >= 500) {
        failed += 1;
        await enqueuePunch({ ...punch, attempts: punch.attempts + 1 });
        continue;
      }

      // Sisanya permanen — data yang tidak akan pernah diterima server.
      await dequeuePunch(punch.dedupeKey);
      failed += 1;
    } catch {
      // Jaringan masih mati. Biarkan di antrean.
      failed += 1;
    }
  }

  const remainingAll = await queuedPunches();

  return {
    sent,
    failed,
    // Yang dihitung hanya milik pengguna saat ini. Indikator "3 belum terkirim"
    // yang sebenarnya milik rekan shift sebelumnya akan membuat orang menunggu
    // sesuatu yang tidak akan pernah terkirim untuknya.
    remaining: remainingAll.filter((punch) => punch.ownerUserId === currentUserId).length,
    /** Milik pengguna lain di perangkat ini. Ditampilkan terpisah, bukan disembunyikan. */
    otherUsers: remainingAll.filter((punch) => punch.ownerUserId !== currentUserId).length,
  };
}

/**
 * Meminta penyimpanan persisten.
 *
 * Mengembalikan false bila peramban menolak — dan itu bukan galat, melainkan
 * informasi yang harus diteruskan ke pengguna. Pada iOS, penolakan berarti
 * antrean dapat hilang setelah tujuh hari tidak dibuka.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
