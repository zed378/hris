import { describe, expect, it } from 'vitest';
import { stripJpegMetadata, PhotoError } from '../src/attendance/photo.ts';

/**
 * Uji penghapusan metadata JPEG.
 *
 * Yang diuji di sini adalah janji privasi paling konkret dalam sistem: foto
 * swafoto presensi tidak boleh membawa koordinat GPS. Foto yang membawanya
 * bukan bukti kehadiran — ia pelacak lokasi yang menyamar sebagai bukti
 * kehadiran, dan ia bertahan 90 hari.
 */

/** Membangun JPEG minimal dengan segmen yang dapat dikenali. */
function buildJpeg(options: { withExif?: boolean; withIcc?: boolean; withComment?: boolean }) {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  // APP0/JFIF — segmen sah yang HARUS dipertahankan.
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0, 1, 0, 1, 0, 0]);
  parts.push(Buffer.from([0xff, 0xe0]), lengthOf(jfif), jfif);

  if (options.withExif) {
    // APP1 berisi penanda EXIF dan payload yang mewakili tag GPS.
    const exif = Buffer.concat([
      Buffer.from('Exif\0\0', 'ascii'),
      Buffer.from('GPSLatitude=-6.1753924;GPSLongitude=106.8271528', 'ascii'),
    ]);
    parts.push(Buffer.from([0xff, 0xe1]), lengthOf(exif), exif);
  }

  if (options.withIcc) {
    const icc = Buffer.from('ICC_PROFILE\0payload', 'ascii');
    parts.push(Buffer.from([0xff, 0xe2]), lengthOf(icc), icc);
  }

  if (options.withComment) {
    const comment = Buffer.from('Dibuat dengan Ponsel Merek X SN12345', 'ascii');
    parts.push(Buffer.from([0xff, 0xfe]), lengthOf(comment), comment);
  }

  // SOS dan data gambar tiruan.
  const sos = Buffer.from([0x01, 0x01, 0x00]);
  parts.push(Buffer.from([0xff, 0xda]), lengthOf(sos), sos);
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0x78]));
  parts.push(Buffer.from([0xff, 0xd9]));

  return Buffer.concat(parts);
}

function lengthOf(payload: Buffer): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(payload.length + 2);
  return buffer;
}

describe('penghapusan metadata JPEG', () => {
  it('membuang koordinat GPS dari EXIF', () => {
    const withGps = buildJpeg({ withExif: true });
    expect(withGps.toString('latin1')).toContain('GPSLatitude');

    const clean = stripJpegMetadata(withGps);
    expect(clean.toString('latin1')).not.toContain('GPSLatitude');
    expect(clean.toString('latin1')).not.toContain('Exif');
  });

  it('membuang profil ICC dan komentar', () => {
    const dirty = buildJpeg({ withIcc: true, withComment: true });
    const clean = stripJpegMetadata(dirty);

    expect(clean.toString('latin1')).not.toContain('ICC_PROFILE');
    // Komentar sering memuat model perangkat dan nomor seri — sama pribadinya
    // dengan koordinat, dan sama tidak diperlukannya sebagai bukti kehadiran.
    expect(clean.toString('latin1')).not.toContain('SN12345');
  });

  it('mempertahankan JFIF agar berkasnya tetap dapat dibuka', () => {
    // Membuang semua segmen APP akan menghasilkan berkas yang bersih tetapi
    // tidak dapat ditampilkan sebagian peramban. Yang dibuang harus tepat.
    const clean = stripJpegMetadata(buildJpeg({ withExif: true }));
    expect(clean.toString('latin1')).toContain('JFIF');
  });

  it('mempertahankan data gambar setelah SOS', () => {
    const clean = stripJpegMetadata(buildJpeg({ withExif: true, withComment: true }));

    // Penanda akhir berkas harus utuh; tanpa itu gambar terpotong.
    expect(clean.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(clean.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(true);
  });

  it('berkas bersih tetap bersih dan tetap sah', () => {
    const clean = buildJpeg({});
    const result = stripJpegMetadata(clean);

    expect(result.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(result.length).toBeLessThanOrEqual(clean.length);
  });

  it('menolak berkas yang bukan JPEG', () => {
    // PNG dan HEIC dari iPhone akan sampai ke sini bila kompresi klien gagal.
    // Menolaknya lebih baik daripada menyimpan berkas yang metadatanya tidak
    // pernah diperiksa.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => stripJpegMetadata(png)).toThrow(PhotoError);
  });

  it('menolak berkas kosong', () => {
    expect(() => stripJpegMetadata(Buffer.alloc(0))).toThrow(PhotoError);
  });
});
