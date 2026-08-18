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
  remaining: number;
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
): Promise<FlushResult> {
  const queue = await queuedPunches();
  let sent = 0;
  let failed = 0;

  for (const punch of queue) {
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

  return { sent, failed, remaining: (await queuedPunches()).length };
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
