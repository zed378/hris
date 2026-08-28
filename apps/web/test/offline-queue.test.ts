import { describe, expect, it } from 'vitest';
import { flushQueue, type QueuedPunch } from '../src/lib/offline-queue.ts';

/**
 * Kepemilikan antrean presensi luring.
 *
 * Bug yang ditutup uji ini ditemukan saat menutup DoD Fase 3, dan ia tidak
 * menghasilkan galat apa pun.
 *
 * Antrean luring SENGAJA bertahan setelah logout: ia milik perangkat, bukan
 * milik sesi. Tetapi server menurunkan `employeeId` dari SESI, bukan dari isi
 * ketukan. Pada perangkat bersama — ponsel gudang tiga shift, komputer pos
 * satpam — urutannya menjadi:
 *
 *   A mengetuk saat jaringan mati → A keluar → B masuk → ketukan A terkirim
 *   dengan token B, dan tercatat sebagai kehadiran B.
 *
 * Presensi A lenyap; B menerima kehadiran yang tidak ia lakukan. Keduanya baru
 * terlihat saat slip gaji terbit.
 */

/** IndexedDB tidak ada di lingkungan uji; antreannya dipalsukan di memori. */
const store = new Map<string, QueuedPunch>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).indexedDB = {
  open: () => {
    const request: Record<string, unknown> = { result: fakeDb() };
    setTimeout(() => (request['onsuccess'] as (() => void) | undefined)?.(), 0);
    return request;
  },
};

function fakeDb() {
  return {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        put: (value: QueuedPunch) => {
          store.set(value.dedupeKey, value);
          return doneRequest(undefined);
        },
        delete: (key: string) => {
          store.delete(key);
          return doneRequest(undefined);
        },
        getAll: () => doneRequest([...store.values()]),
      }),
      oncomplete: null,
    }),
  };
}

function doneRequest(result: unknown) {
  const request: Record<string, unknown> = { result };
  setTimeout(() => (request['onsuccess'] as (() => void) | undefined)?.(), 0);
  return request;
}

function punch(ownerUserId: string, dedupeKey: string): QueuedPunch {
  return {
    ownerUserId,
    dedupeKey,
    type: 'IN',
    punchedAt: '2026-08-28T01:00:00.000Z',
    latitude: null,
    longitude: null,
    accuracyM: null,
    photoKey: null,
    deviceInfo: null,
    queuedAt: '2026-08-28T01:00:00.000Z',
    attempts: 0,
  };
}

describe('antrean luring tidak mengirim ketukan atas nama orang lain', () => {
  it('hanya mengirim ketukan milik pengguna yang sedang masuk', async () => {
    store.clear();
    store.set('a1', punch('user-A', 'a1'));
    store.set('a2', punch('user-A', 'a2'));
    store.set('b1', punch('user-B', 'b1'));

    const dikirim: string[] = [];
    const hasil = await flushQueue(async (p) => {
      dikirim.push(p.dedupeKey);
      return new Response(null, { status: 201 });
    }, 'user-A');

    expect(dikirim.sort()).toEqual(['a1', 'a2']);
    expect(hasil.sent).toBe(2);
    expect(hasil.otherUsers).toBe(1);
  });

  it('TIDAK membuang ketukan milik orang lain', async () => {
    // Pemiliknya mungkin masuk lagi nanti di perangkat yang sama, dan
    // presensinya masih dapat terkirim. Membuangnya berarti menghilangkan
    // kehadiran seseorang karena orang lain memakai perangkat itu lebih dulu.
    store.clear();
    store.set('b1', punch('user-B', 'b1'));

    await flushQueue(async () => new Response(null, { status: 201 }), 'user-A');

    expect(store.has('b1')).toBe(true);
  });

  it('mengirimkannya begitu pemiliknya masuk', async () => {
    store.clear();
    store.set('b1', punch('user-B', 'b1'));

    const dikirim: string[] = [];
    const hasil = await flushQueue(async (p) => {
      dikirim.push(p.dedupeKey);
      return new Response(null, { status: 201 });
    }, 'user-B');

    expect(dikirim).toEqual(['b1']);
    expect(hasil.sent).toBe(1);
    expect(hasil.otherUsers).toBe(0);
  });

  it('tidak menghitung ketukan orang lain sebagai kegagalan', async () => {
    // Ia bukan kegagalan; ia sekadar bukan giliran ketukan itu. Menghitungnya
    // gagal akan memunculkan indikator galat yang tidak dapat diperbaiki siapa
    // pun yang sedang melihatnya.
    store.clear();
    store.set('b1', punch('user-B', 'b1'));

    const hasil = await flushQueue(async () => new Response(null, { status: 201 }), 'user-A');

    expect(hasil.failed).toBe(0);
    expect(hasil.remaining).toBe(0);
    expect(hasil.otherUsers).toBe(1);
  });
});
