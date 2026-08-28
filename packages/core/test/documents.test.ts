import { describe, expect, it } from 'vitest';
import { sniffType } from '../src/employee/documents.ts';

/**
 * Penentuan jenis berkas dokumen karyawan.
 *
 * Yang diuji di sini adalah penolakan berkas yang MENGAKU sebagai PDF. Nama
 * berkas dan `content-type` sama-sama dikirim klien, sehingga keduanya dapat
 * berbohong — dan berkas berbahaya bernama `ktp.pdf` yang lolos akan tersimpan
 * di server yang sama dengan data gaji, terlihat persis seperti dokumen sah.
 */

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(16),
]);

describe('pengenalan jenis dokumen dari isinya', () => {
  it('mengenali jenis yang diterima', () => {
    expect(sniffType(pdf)).toBe('application/pdf');
    expect(sniffType(jpeg)).toBe('image/jpeg');
    expect(sniffType(png)).toBe('image/png');
    expect(sniffType(webp)).toBe('image/webp');
  });

  it('menolak berkas yang mengaku PDF lewat namanya saja', () => {
    // Inilah serangan yang sesungguhnya: skrip bernama `ktp.pdf`, dikirim
    // dengan `content-type: application/pdf`. Pemeriksaan apa pun yang hanya
    // membaca metadata akan menerimanya.
    const skrip = Buffer.from('#!/bin/sh\nrm -rf /\n', 'latin1');
    expect(sniffType(skrip)).toBeNull();
  });

  it('menolak berkas Office yang lazim salah diunggah', () => {
    // DOCX dan XLSX adalah arsip ZIP. Menerimanya berarti menyimpan arsip yang
    // isinya tidak pernah diperiksa.
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]);
    expect(sniffType(docx)).toBeNull();
  });

  it('menolak berkas yang terlalu pendek untuk dikenali', () => {
    // Unggahan yang terputus di tengah jalan. Menerimanya menghasilkan baris
    // yang tampak seperti dokumen sampai seseorang mencoba membukanya.
    expect(sniffType(Buffer.alloc(0))).toBeNull();
    expect(sniffType(Buffer.from('%PDF', 'latin1'))).toBeNull();
  });

  it('tidak tertipu RIFF yang bukan WebP', () => {
    // Berkas WAV juga diawali RIFF. Memeriksa empat byte pertama saja akan
    // menerimanya sebagai gambar.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(sniffType(wav)).toBeNull();
  });
});
