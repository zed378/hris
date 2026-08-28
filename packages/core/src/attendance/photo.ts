import { createBlobStore, BlobError, type DeleteOutcome } from '../storage/index.ts';

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
 * Penyimpanan foto presensi.
 *
 * Path, validasi kunci, dan pembedaan "sudah tidak ada" dari "gagal dihapus"
 * ditangani `@hrms/core/storage` — ketiganya pernah salah di sini, dan
 * memperbaikinya di satu tempat lebih murah daripada mengingat untuk
 * memperbaikinya di setiap tempat.
 */
const store = createBlobStore({
  envVar: 'PHOTO_STORAGE_DIR',
  fallbackDir: './.storage/attendance-photos',
  extensions: ['jpg'],
  maxBytes: MAX_PHOTO_BYTES,
});

export async function storePhoto(input: Buffer): Promise<StoredPhoto> {
  if (input.length > MAX_PHOTO_BYTES) {
    throw new PhotoError(
      `Ukuran foto ${Math.round(input.length / 1024)} KB melebihi batas ${MAX_PHOTO_BYTES / 1024} KB`,
      'too_large',
    );
  }

  // EXIF dibuang SEBELUM disimpan, bukan saat disajikan. Berkas yang pernah
  // menyentuh disk dengan koordinat di dalamnya sudah terlanjur ada di cadangan.
  return store.put(stripJpegMetadata(input), 'jpg');
}

export async function readPhoto(key: string): Promise<Buffer> {
  try {
    return await store.get(key);
  } catch (error) {
    throw new PhotoError(
      error instanceof BlobError && error.kind === 'invalid_key'
        ? 'Kunci foto tidak sah'
        : 'Foto tidak ditemukan atau sudah melewati masa retensi',
      error instanceof BlobError && error.kind === 'invalid_key' ? 'invalid_format' : 'not_found',
    );
  }
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
    return await store.remove(key);
  } catch (error) {
    // Galat penyimpanan diterjemahkan ke kosakata modul ini. Pemanggil di
    // `apps/worker` dan `apps/web` menangkap `PhotoError`; membocorkan
    // `BlobError` lewat pintu depan akan membuat penanganan galat mereka
    // meleset tanpa satu pun galat kompilasi.
    if (error instanceof BlobError) {
      throw new PhotoError(
        error.kind === 'invalid_key' ? 'Kunci foto tidak sah' : error.message,
        error.kind === 'invalid_key' ? 'invalid_format' : 'not_found',
      );
    }
    throw error;
  }
}
