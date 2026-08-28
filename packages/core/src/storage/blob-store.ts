import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Penyimpanan berkas biner.
 *
 * Ditarik keluar dari pipeline foto presensi setelah dokumen karyawan
 * membutuhkan hal yang sama. Bukan abstraksi yang dicari-cari: versi pertama
 * penyimpanan foto membawa dua bug yang saling menyembunyikan — path relatif
 * yang berbeda per proses, dan penghapusan yang menelan galat — dan menyalin
 * pola yang sama ke dokumen karyawan berarti menyalin keduanya sekaligus,
 * lengkap dengan sifat diamnya.
 *
 * Antarmukanya sengaja sesempit ini supaya penggantinya ke S3-compatible kelak
 * hanya menyentuh satu berkas.
 */

export class BlobError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_key' | 'not_found' | 'too_large',
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

/**
 * Akar penyimpanan.
 *
 * Path relatif diselesaikan terhadap akar repositori, BUKAN terhadap direktori
 * kerja proses. Perbedaannya bukan kerapian: `apps/web` dan `apps/worker`
 * berjalan dari direktori berbeda, sehingga path relatif membuat keduanya
 * menunjuk tempat yang berlainan — satu proses menulis, proses lain mencari di
 * tempat yang salah, dan job pembersihan melaporkan berhasil menghapus berkas
 * yang tidak pernah ia temukan.
 */
function storageRoot(envVar: string, fallback: string): string {
  const configured = process.env[envVar] ?? fallback;
  if (isAbsolute(configured)) return configured;

  // packages/core/src/storage/blob-store.ts → naik empat tingkat ke akar repositori.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../..', configured);
}

export interface DeleteOutcome {
  /** Berkas benar-benar dihapus pada pemanggilan ini. */
  removed: boolean;
  /** Berkas memang sudah tidak ada. Bukan galat. */
  alreadyGone: boolean;
}

export interface BlobStore {
  /** Menyimpan isi dan mengembalikan kuncinya. */
  put: (content: Buffer, extension: string) => Promise<{ key: string; bytes: number }>;
  get: (key: string) => Promise<Buffer>;
  /** Ukuran berkas dalam byte, atau null bila tidak ada. */
  size: (key: string) => Promise<number | null>;
  /**
   * Menghapus berkas.
   *
   * Membedakan "sudah tidak ada" dari "gagal dihapus". Versi pertama pipeline
   * foto menelan seluruh galat, sehingga berkas yang TIDAK DITEMUKAN dilaporkan
   * sebagai berhasil dihapus — job retensi terlihat bekerja sempurna sementara
   * setiap berkas masih ada di disk. Kegagalan selain berkas-tidak-ada dilempar,
   * supaya pemanggil dapat menghitungnya dan tidak menghapus rujukannya.
   */
  remove: (key: string) => Promise<DeleteOutcome>;
}

/**
 * Membuat penyimpanan dengan akar dan aturan kunci sendiri.
 *
 * `envVar` memungkinkan tiap jenis berkas dipindahkan terpisah — foto presensi
 * ke volume berumur pendek, dokumen karyawan ke volume yang dicadangkan.
 */
export function createBlobStore(options: {
  envVar: string;
  fallbackDir: string;
  /** Ekstensi yang diterima, tanpa titik. */
  extensions: string[];
  maxBytes: number;
}): BlobStore {
  const allowed = new Set(options.extensions.map((extension) => extension.toLowerCase()));

  // Kunci divalidasi agar tidak dapat keluar dari direktori penyimpanan. Tanpa
  // ini, kunci berisi "../" mengubah endpoint penyajian berkas menjadi pembaca
  // berkas sembarang — dan job pembersihan menjadi penghapus berkas sembarang.
  const pathFor = (key: string): string => {
    const match = /^([0-9a-f-]{36})\.([a-z0-9]{1,5})$/.exec(key);
    if (!match || !allowed.has(match[2]!)) {
      throw new BlobError('Kunci berkas tidak sah', 'invalid_key');
    }
    return join(storageRoot(options.envVar, options.fallbackDir), key.slice(0, 2), key);
  };

  return {
    async put(content, extension) {
      if (content.length > options.maxBytes) {
        throw new BlobError(
          `Ukuran berkas ${Math.round(content.length / 1024)} KB melebihi batas ${Math.round(options.maxBytes / 1024)} KB`,
          'too_large',
        );
      }

      // Kunci memuat UUID acak, bukan id karyawan atau tanggal. Kunci yang dapat
      // ditebak berarti siapa pun yang mengetahui polanya dapat mengambil berkas
      // orang lain hanya dengan menyusun URL-nya, sehingga otorisasi di endpoint
      // penyajian menjadi satu-satunya penjaga alih-alih lapisan kedua.
      const key = `${randomUUID()}.${extension.toLowerCase()}`;
      const path = pathFor(key);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);

      return { key, bytes: content.length };
    },

    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if (error instanceof BlobError) throw error;
        throw new BlobError('Berkas tidak ditemukan', 'not_found');
      }
    },

    async size(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
    },

    async remove(key) {
      try {
        await unlink(pathFor(key));
        return { removed: true, alreadyGone: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { removed: false, alreadyGone: true };
        }
        throw error;
      }
    },
  };
}
