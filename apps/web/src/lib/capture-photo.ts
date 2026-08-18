'use client';

/**
 * Pengambilan dan kompresi foto swafoto presensi (dokumen 10 §4.2).
 *
 * Kompresi dilakukan di perangkat, bukan di server. Foto mentah dari kamera
 * ponsel modern berukuran 3–8 MB; mengirimkannya lewat jaringan seluler di
 * kawasan industri berarti presensi yang gagal karena timeout, atau kuota
 * karyawan yang habis untuk sesuatu yang seharusnya tidak terasa.
 *
 * Efek samping yang menguntungkan: menggambar ulang ke canvas membuang seluruh
 * metadata, termasuk EXIF berisi koordinat GPS. Server tetap membuangnya lagi —
 * apa yang dikirim klien tidak pernah menjadi dasar jaminan privasi.
 */

/** Sisi terpanjang setelah pengubahan ukuran. Cukup untuk mengenali wajah. */
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 0.7;

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'unavailable' | 'failed',
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * Mengubah ukuran dan mengompresi berkas gambar menjadi JPEG.
 *
 * Memakai `createImageBitmap` yang menghormati orientasi EXIF sebelum metadata
 * itu dibuang — tanpanya, foto dari sebagian ponsel tersimpan terbalik 90 derajat
 * dan HR meninjau antrean berisi wajah menyamping.
 */
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new CaptureError('Gambar tidak dapat dibaca', 'failed');
  });

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new CaptureError('Perangkat tidak mendukung pemrosesan gambar', 'unavailable');

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new CaptureError('Gagal mengompresi foto', 'failed')),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * Membuka kamera lewat input berkas, bukan `getUserMedia`.
 *
 * `capture="user"` membuka kamera depan langsung di ponsel, dan di desktop ia
 * jatuh ke pemilih berkas biasa. `getUserMedia` memberi pratinjau langsung yang
 * lebih baik, tetapi menuntut izin kamera yang bertahan, penanganan orientasi
 * sendiri, dan pembersihan stream — kompleksitas yang tidak sebanding untuk satu
 * foto per ketukan.
 *
 * Batas yang perlu diketahui: input berkas mengizinkan pengguna memilih foto
 * dari galeri alih-alih memotret. Itu tidak dapat dicegah di web sama sekali,
 * dan justru alasan presensi peramban selalu mendapat penalti kepercayaan
 * (dokumen 10 §1.1).
 */
export function openCamera(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'user';

    input.onchange = () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      else reject(new CaptureError('Tidak ada foto yang dipilih', 'failed'));
    };

    // Peramban tidak memberi tahu bila dialog ditutup tanpa memilih. Yang terjadi
    // hanyalah promise yang tidak pernah selesai — jadi pemanggil harus tetap
    // dapat melanjutkan tanpa foto.
    input.click();
  });
}
