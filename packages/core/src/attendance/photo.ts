import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Pipeline foto presensi (dokumen 10 §4).
 *
 * Empat hal yang wajib terjadi pada setiap foto, dan urutannya penting:
 *
 *   1. Validasi   — hanya JPEG, hanya di bawah batas ukuran.
 *   2. Hapus EXIF — koordinat GPS, model perangkat, dan nomor seri kamera
 *                   dibuang. Foto swafoto presensi yang membawa EXIF adalah
 *                   pelacak lokasi yang menyamar sebagai bukti kehadiran.
 *   3. Simpan     — dengan kunci yang tidak dapat ditebak.
 *   4. Retensi    — 90 hari, lalu dihapus. Catatan presensinya tetap utuh.
 *
 * Langkah 2 dilakukan di server meski klien sudah mengompresi lewat canvas
 * (yang kebetulan membuang EXIF). Bukti yang dikirim klien tidak pernah menjadi
 * dasar jaminan privasi — klien dapat diganti, dan yang menanggung akibatnya
 * adalah karyawan yang tidak tahu fotonya membawa koordinat rumahnya.
 */

/** Batas ukuran setelah kompresi klien. Foto 800px JPEG q0.7 ≈ 80–150 KB. */
export const MAX_PHOTO_BYTES = 512 * 1024;

export class PhotoError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_format' | 'too_large' | 'not_found',
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

/**
 * Membuang seluruh segmen metadata dari JPEG.
 *
 * Ditulis tangan alih-alih memakai `sharp`. Alasannya bukan keengganan memakai
 * pustaka: `sharp` membawa biner native yang harus dibangun ulang per arsitektur,
 * dan satu-satunya yang dibutuhkan di sini adalah membuang segmen — bukan
 * mengubah piksel. Klien sudah menangani pengubahan ukuran lewat canvas.
 *
 * Struktur JPEG cukup sederhana untuk ini: berkas adalah rangkaian segmen yang
 * masing-masing diawali 0xFF diikuti penanda dan panjangnya. Yang dibuang adalah
 * APP1 (EXIF, XMP), APP2 (ICC), dan COM (komentar).
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new PhotoError('Berkas bukan JPEG yang sah', 'invalid_format');
  }

  const output: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;

  while (offset < input.length - 1) {
    if (input[offset] !== 0xff) break;

    const marker = input[offset + 1]!;

    // 0xDA memulai data terkompresi; sisanya sampai akhir berkas disalin apa
    // adanya. Tidak ada metadata setelah titik ini.
    if (marker === 0xda) {
      output.push(input.subarray(offset));
      break;
    }

    // Penanda tanpa payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = input.readUInt16BE(offset + 2);
    const segment = input.subarray(offset, offset + 2 + length);

    // APP1 (0xE1) memuat EXIF dan XMP — di situlah koordinat GPS berada.
    // APP2 (0xE2) memuat profil ICC. COM (0xFE) memuat komentar bebas.
    const isMetadata = marker === 0xe1 || marker === 0xe2 || marker === 0xfe;
    if (!isMetadata) output.push(segment);

    offset += 2 + length;
  }

  return Buffer.concat(output);
}

export interface StoredPhoto {
  key: string;
  bytes: number;
}

/**
 * Penyimpanan foto.
 *
 * Implementasi lokal untuk pengembangan dan deployment satu VPS — yang memang
 * topologi yang direncanakan (PLAN/12 §3.2). Antarmukanya sengaja sesempit ini
 * supaya penggantinya ke S3-compatible kelak hanya menyentuh satu berkas.
 *
 * Kunci objek memuat UUID acak, bukan id karyawan atau tanggal. Kunci yang dapat
 * ditebak berarti siapa pun yang mengetahui polanya dapat mengambil foto orang
 * lain hanya dengan menyusun URL-nya — dan otorisasi di endpoint penyajian
 * menjadi satu-satunya penjaga, bukan lapisan kedua.
 */
/**
 * Akar penyimpanan foto.
 *
 * Path relatif diselesaikan terhadap akar repositori, BUKAN terhadap direktori
 * kerja proses. Perbedaannya bukan kerapian: `apps/web` dan `apps/worker`
 * berjalan dari direktori yang berbeda, sehingga path relatif membuat keduanya
 * menunjuk tempat yang berlainan — web menulis foto di satu tempat, job retensi
 * mencarinya di tempat lain.
 *
 * Kegagalannya tidak terlihat: job melaporkan berhasil menghapus, rujukan di
 * basis data dibersihkan, dan berkasnya tetap ada di disk selamanya. Janji
 * retensi 90 hari batal tanpa satu pun galat.
 */
function storageRoot(): string {
  const configured = process.env['PHOTO_STORAGE_DIR'] ?? './.storage/attendance-photos';
  if (isAbsolute(configured)) return configured;

  // packages/core/src/attendance/photo.ts → naik lima tingkat ke akar repositori.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../..', configured);
}

function pathFor(key: string): string {
  // Kunci divalidasi agar tidak dapat keluar dari direktori penyimpanan. Tanpa
  // ini, kunci berisi "../" mengubah endpoint penyajian foto menjadi pembaca
  // berkas sembarang.
  if (!/^[0-9a-f-]{36}\.jpg$/.test(key)) {
    throw new PhotoError('Kunci foto tidak sah', 'invalid_format');
  }
  return join(storageRoot(), key.slice(0, 2), key);
}

export async function storePhoto(input: Buffer): Promise<StoredPhoto> {
  if (input.length > MAX_PHOTO_BYTES) {
    throw new PhotoError(
      `Ukuran foto ${Math.round(input.length / 1024)} KB melebihi batas ${MAX_PHOTO_BYTES / 1024} KB`,
      'too_large',
    );
  }

  const clean = stripJpegMetadata(input);
  const key = `${randomUUID()}.jpg`;
  const path = pathFor(key);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, clean);

  return { key, bytes: clean.length };
}

export async function readPhoto(key: string): Promise<Buffer> {
  try {
    return await readFile(pathFor(key));
  } catch {
    throw new PhotoError('Foto tidak ditemukan atau sudah melewati masa retensi', 'not_found');
  }
}

export interface DeleteOutcome {
  /** Berkas benar-benar dihapus pada pemanggilan ini. */
  removed: boolean;
  /** Berkas memang sudah tidak ada. Bukan galat. */
  alreadyGone: boolean;
}

/**
 * Menghapus berkas foto.
 *
 * Membedakan "sudah tidak ada" dari "gagal dihapus", dan itu perbedaan yang
 * menanggung beban. Versi pertama menelan seluruh galat, sehingga berkas yang
 * TIDAK DITEMUKAN — karena path penyimpanannya salah — dilaporkan sebagai
 * berhasil dihapus. Job retensi terlihat bekerja sempurna sementara setiap foto
 * yang pernah diunggah masih tersimpan di disk.
 *
 * Kegagalan selain berkas-tidak-ada dilempar, supaya pemanggil dapat
 * menghitungnya dan TIDAK menghapus rujukannya di basis data. Rujukan yang
 * bertahan adalah satu-satunya cara putaran berikutnya menemukan berkas itu lagi.
 */
export async function deletePhoto(key: string): Promise<DeleteOutcome> {
  try {
    await unlink(pathFor(key));
    return { removed: true, alreadyGone: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: false, alreadyGone: true };
    }
    throw error;
  }
}
