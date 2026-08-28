import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Konteks permintaan yang mengalir tanpa diteruskan tangan ke tangan.
 *
 * Masalah yang diselesaikannya: `correlationId` sudah ada di lapisan HTTP dan
 * sudah ada kolomnya di tabel outbox, tetapi tidak pernah sampai ke antaranya.
 * Dari dua belas pemanggilan `publishEvent`, hanya sebagian yang mengisinya —
 * dan yang tidak mengisi bukan karena lalai, melainkan karena fungsi yang
 * memanggilnya memang tidak menerima `ctx`.
 *
 * Meneruskannya sebagai parameter ke setiap fungsi domain akan menambah satu
 * argumen pada puluhan tanda tangan yang tidak ada urusannya dengan pencatatan,
 * dan argumen itu akan lupa diisi pada fungsi berikutnya yang ditulis orang.
 *
 * `AsyncLocalStorage` menyelesaikannya di tempat yang benar: satu pembungkus di
 * batas permintaan, lalu setiap lapisan di bawahnya dapat membacanya tanpa
 * mengetahui keberadaannya.
 *
 * **Yang TIDAK boleh masuk ke sini:** identitas pengguna sebagai dasar
 * otorisasi, dan tenant sebagai dasar isolasi data. Keduanya wajib diteruskan
 * eksplisit — `withTenant(tenantId, …)` memasang konteks RLS lewat parameter
 * dengan sengaja. Otorisasi yang membaca keadaan implisit adalah otorisasi yang
 * dapat bocor lintas permintaan ketika satu `await` lupa ditunggu.
 *
 * Isi di sini hanya untuk PENCATATAN.
 */

export interface RequestContext {
  correlationId: string;
  /** Untuk log saja. Isolasi data tetap lewat `withTenant`. */
  tenantId?: string | undefined;
  routeId?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Menjalankan sebuah fungsi di dalam konteks permintaan.
 *
 * Dipanggil satu kali di batas permintaan. Nesting dibolehkan — yang terdalam
 * menang — supaya job latar dapat membuat konteksnya sendiri.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Konteks yang sedang berlaku, atau `undefined` di luar permintaan.
 *
 * `undefined` adalah hasil yang sah, bukan galat: job terjadwal dan skrip CLI
 * berjalan tanpa konteks permintaan, dan memaksa mereka membuat satu hanya
 * untuk memuaskan tipe akan menghasilkan id korelasi palsu yang tidak
 * berhubungan dengan apa pun.
 */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** `correlationId` yang berlaku, bila ada. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
