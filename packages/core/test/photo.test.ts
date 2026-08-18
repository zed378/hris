import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deletePhoto,
  PhotoError,
  readPhoto,
  storePhoto,
  stripJpegMetadata,
} from '../src/attendance/photo.ts';

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

/**
 * Kontrak penghapusan.
 *
 * Ini menutup dua bug yang saling menyembunyikan. Path penyimpanan dulu relatif
 * terhadap direktori kerja proses, sehingga `apps/web` menulis foto di satu
 * tempat dan job retensi mencarinya di tempat lain. Dan `deletePhoto` dulu
 * menelan seluruh galat, sehingga berkas yang tidak ditemukan dilaporkan sebagai
 * berhasil dihapus.
 *
 * Gabungannya: job retensi melaporkan bekerja sempurna, rujukan di basis data
 * dibersihkan, dan setiap foto yang pernah diunggah tetap ada di disk selamanya.
 * Tidak satu pun galat terlihat. Janji retensi 90 hari UU PDP batal dalam diam —
 * dan diamnya itulah yang membuat bug ini mahal, bukan salah path-nya.
 */
describe('kontrak penghapusan foto', () => {
  const sandbox = join(tmpdir(), `hrms-photo-${randomUUID()}`);
  const original = process.env['PHOTO_STORAGE_DIR'];

  beforeAll(() => {
    process.env['PHOTO_STORAGE_DIR'] = sandbox;
  });

  afterAll(async () => {
    if (original === undefined) delete process.env['PHOTO_STORAGE_DIR'];
    else process.env['PHOTO_STORAGE_DIR'] = original;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('menyimpan lalu membacanya kembali tanpa metadata', async () => {
    const { key } = await storePhoto(buildJpeg({ withExif: true }));
    const back = await readPhoto(key);

    expect(back.toString('latin1')).not.toContain('GPSLatitude');
    expect(back.toString('latin1')).toContain('JFIF');
  });

  it('melaporkan `removed` saat berkasnya benar-benar dihapus', async () => {
    const { key } = await storePhoto(buildJpeg({}));

    expect(await deletePhoto(key)).toEqual({ removed: true, alreadyGone: false });
    await expect(readPhoto(key)).rejects.toThrow(PhotoError);
  });

  it('membedakan "sudah tidak ada" dari "berhasil dihapus"', async () => {
    // Wajar setelah pemulihan cadangan: rujukannya kembali, berkasnya tidak.
    // Ini bukan kegagalan — rujukannya boleh dihapus.
    const { key } = await storePhoto(buildJpeg({}));
    await deletePhoto(key);

    expect(await deletePhoto(key)).toEqual({ removed: false, alreadyGone: true });
  });

  it('melempar galat selain berkas-tidak-ada, tidak menelannya', async () => {
    // Sebuah direktori bernama sama membuat `unlink` mengembalikan EPERM. Yang
    // diuji bukan kasus direktori itu sendiri, melainkan bahwa kegagalan APA PUN
    // di luar ENOENT sampai ke pemanggil — karena pemanggilnya yang memutuskan
    // untuk TIDAK menghapus rujukan basis data, dan rujukan yang bertahan itulah
    // satu-satunya cara putaran berikutnya menemukan berkasnya lagi.
    const key = `${randomUUID()}.jpg`;
    await mkdir(join(sandbox, key.slice(0, 2), key), { recursive: true });

    await expect(deletePhoto(key)).rejects.toThrow(/EPERM|EISDIR/);
  });

  it('menolak kunci yang keluar dari direktori penyimpanan', async () => {
    // Tanpa ini, endpoint penyajian foto berubah menjadi pembaca berkas
    // sembarang, dan job retensi menjadi penghapus berkas sembarang.
    await expect(readPhoto('../../../package.json')).rejects.toThrow(PhotoError);
    await expect(deletePhoto('..%2Fpackage.json')).rejects.toThrow(PhotoError);
  });
});
