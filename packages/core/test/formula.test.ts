import { describe, expect, it } from 'vitest';
import { Prisma } from '@hrms/db';
import {
  evaluateFormula,
  checkFormula,
  FormulaError,
  AVAILABLE_FUNCTIONS,
} from '../src/payroll/formula.ts';

/**
 * Parser formula gaji.
 *
 * Dua hal yang diuji di sini, dan keduanya menentukan apakah modul payroll layak
 * dijalankan sama sekali:
 *
 *   1. **Tidak ada jalan menuju eksekusi kode.** Formula ditulis admin HR
 *      tenant lewat antarmuka web. Satu celah di sini berarti setiap admin
 *      tenant memegang eksekusi kode arbitrer di server yang memegang data gaji
 *      seluruh tenant lain.
 *   2. **Aritmetika desimal, bukan float.** DoD Fase 5 menuntut kecocokan
 *      sampai satuan rupiah, dan `0.1 + 0.2` dalam IEEE-754 tidak sama dengan
 *      `0.3`.
 */

const n = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);
const hitung = (expression: string, scope: Record<string, number | Prisma.Decimal> = {}): string =>
  evaluateFormula(expression, scope).toString();

describe('aritmetika', () => {
  it('menghitung operasi dasar', () => {
    expect(hitung('2 + 3')).toBe('5');
    expect(hitung('10 - 4')).toBe('6');
    expect(hitung('6 * 7')).toBe('42');
    expect(hitung('20 / 4')).toBe('5');
    expect(hitung('17 % 5')).toBe('2');
  });

  it('menghormati presedensi tanpa perlu tanda kurung', () => {
    expect(hitung('2 + 3 * 4')).toBe('14');
    expect(hitung('(2 + 3) * 4')).toBe('20');
  });

  it('menghitung dengan presisi desimal, bukan float', () => {
    // Inilah alasan Decimal dipakai. `0.1 + 0.2` dalam JavaScript biasa
    // menghasilkan 0.30000000000000004, dan selisih itu menjadi rupiah yang
    // tidak dapat dijelaskan pada slip gaji.
    expect(hitung('0.1 + 0.2')).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('menghitung potongan gaji tanpa pembulatan yang menyimpang', () => {
    // BPJS Kesehatan 1% dari upah, dengan batas atas 12 juta.
    const scope = { UPAH: n('8_500_000'.replace(/_/g, '')) };
    expect(hitung('min(UPAH, 12000000) * 0.01', scope)).toBe('85000');
  });

  it('menerapkan negasi uner', () => {
    expect(hitung('-5 + 10')).toBe('5');
    expect(hitung('-(3 * 4)')).toBe('-12');
    expect(hitung('10 - -5')).toBe('15');
  });
});

describe('variabel', () => {
  it('membaca nilai dari scope', () => {
    expect(hitung('GAJI_POKOK * 0.05', { GAJI_POKOK: 10_000_000 })).toBe('500000');
  });

  it('menerima Decimal maupun number', () => {
    expect(hitung('A + B', { A: n('1.5'), B: 2.5 })).toBe('4');
  });

  it('MELEMPAR untuk variabel yang tidak dikenal, bukan menganggapnya nol', () => {
    // Ini uji terpenting dalam berkas ini. Salah ketik nama variabel yang
    // diperlakukan sebagai nol menghasilkan slip gaji yang salah tanpa satu pun
    // keluhan — dan nol itu terlihat seperti keputusan, bukan kesalahan.
    expect(() => hitung('TUNJANGAN_TRANSPOT * 22', { TUNJANGAN_TRANSPOR: 25_000 })).toThrow(
      FormulaError,
    );
  });

  it('menyebutkan variabel yang tersedia dalam pesan galatnya', () => {
    // Pesan yang hanya berkata "variabel tidak dikenal" memaksa admin menebak.
    expect(() => hitung('SALAH', { GAJI_POKOK: 1, MASA_KERJA: 2 })).toThrow(
      /GAJI_POKOK, MASA_KERJA/,
    );
  });
});

describe('fungsi', () => {
  it('menyediakan min, max, round, floor, ceil, abs, if', () => {
    expect(AVAILABLE_FUNCTIONS).toEqual(['abs', 'ceil', 'floor', 'if', 'max', 'min', 'round']);
  });

  it('membatasi upah pada batas atas BPJS', () => {
    expect(hitung('min(UPAH, 12000000)', { UPAH: 15_000_000 })).toBe('12000000');
    expect(hitung('min(UPAH, 12000000)', { UPAH: 9_000_000 })).toBe('9000000');
  });

  it('membulatkan setengah ke atas', () => {
    // Konvensi perhitungan gaji. ROUND_HALF_EVEN akan membulatkan 2,5 menjadi 2,
    // dan selisih satu rupiah itu menggagalkan uji regresi emas.
    expect(hitung('round(2.5, 0)')).toBe('3');
    expect(hitung('round(1234.567, 2)')).toBe('1234.57');
  });

  it('memilih cabang dengan if', () => {
    expect(hitung('if(MASA_KERJA >= 12, 1000000, 0)', { MASA_KERJA: 18 })).toBe('1000000');
    expect(hitung('if(MASA_KERJA >= 12, 1000000, 0)', { MASA_KERJA: 6 })).toBe('0');
  });

  it('menolak fungsi yang tidak ada dalam daftar putih', () => {
    // Termasuk yang terdengar tidak berbahaya. Daftar putih menutup seluruh
    // permukaan sekaligus; daftar hitam selalu tertinggal satu nama.
    expect(() => hitung('sqrt(16)')).toThrow(/tidak tersedia/);
    expect(() => hitung('eval("1")')).toThrow(FormulaError);
    expect(() => hitung('constructor(1)')).toThrow(FormulaError);
  });

  it('menolak jumlah argumen yang salah', () => {
    expect(() => hitung('round(5)')).toThrow(/membutuhkan 2 argumen/);
    expect(() => hitung('if(1, 2)')).toThrow(/membutuhkan 3 argumen/);
    expect(() => hitung('min()')).toThrow(/sekurangnya satu argumen/);
  });
});

describe('penolakan masukan berbahaya', () => {
  it('tidak dapat mencapai objek global', () => {
    // Tidak ada jalur dari parser ini menuju objek JavaScript apa pun: variabel
    // hanya dicari di scope yang diberikan pemanggil, dan pemanggilan fungsi
    // hanya dicari di daftar putih.
    for (const jahat of [
      'process',
      'globalThis',
      'require("fs")',
      'this.constructor',
      '__proto__',
    ]) {
      expect(() => hitung(jahat)).toThrow(FormulaError);
    }
  });

  it('menolak karakter yang bukan bagian ekspresi', () => {
    expect(() => hitung('1; drop table gaji')).toThrow(/tidak dikenali/);
    expect(() => hitung('`x`')).toThrow(FormulaError);
    expect(() => hitung('{}')).toThrow(FormulaError);
  });

  it('menolak ekspresi yang terlalu panjang', () => {
    expect(() => hitung('1+'.repeat(600) + '1')).toThrow(/terlalu panjang/);
  });

  it('menolak kurung bersarang yang terlalu dalam', () => {
    expect(() => hitung('('.repeat(40) + '1' + ')'.repeat(40))).toThrow(/terlalu dalam/);
  });

  it('menolak pembagian nol alih-alih menghasilkan Infinity', () => {
    // Infinity yang mengalir ke slip gaji lebih buruk daripada run yang
    // berhenti dan mengatakan formulanya salah.
    expect(() => hitung('100 / 0')).toThrow(/Pembagian dengan nol/);
    expect(() => hitung('100 / (A - A)', { A: 5 })).toThrow(FormulaError);
  });

  it('menolak titik sebagai pemisah ribuan', () => {
    // `1.000.000` diketik orang yang terbiasa format Indonesia. Menerimanya
    // sebagai NaN akan menyebarkan NaN sampai ke slip gaji.
    expect(() => hitung('1.000.000')).toThrow(/pemisah ribuan/);
  });

  it('menolak formula yang tidak lengkap', () => {
    expect(() => hitung('2 +')).toThrow(/berakhir lebih awal/);
    expect(() => hitung('(2 + 3')).toThrow(FormulaError);
    expect(() => hitung('2 3')).toThrow(/sisa yang tidak dapat dibaca/);
  });
});

describe('pemeriksaan formula saat konfigurasi', () => {
  const tersedia = ['GAJI_POKOK', 'HARI_KERJA', 'MASA_KERJA'];

  it('menerima formula yang sah dan menyebut variabelnya', () => {
    const hasil = checkFormula('GAJI_POKOK / HARI_KERJA * 22', tersedia);
    expect(hasil.ok).toBe(true);
    expect(hasil.variables.sort()).toEqual(['GAJI_POKOK', 'HARI_KERJA']);
  });

  it('menolak variabel yang tidak tersedia SEBELUM payroll berjalan', () => {
    // Formula yang salah harus ditolak di layar konfigurasi. Menemukannya saat
    // run berarti menemukannya pada tanggal 25, ketika seribu slip harus keluar
    // besok pagi.
    const hasil = checkFormula('GAJI_POKOK * TUNJANGAN_HANTU', tersedia);
    expect(hasil.ok).toBe(false);
    expect(hasil.error?.message).toContain('TUNJANGAN_HANTU');
  });

  it('melaporkan posisi kesalahan sintaks', () => {
    const hasil = checkFormula('GAJI_POKOK * * 2', tersedia);
    expect(hasil.ok).toBe(false);
    expect(hasil.error?.position).toBeGreaterThan(0);
  });

  it('mendaftar fungsi yang dipakai', () => {
    const hasil = checkFormula('min(GAJI_POKOK, 12000000) * 0.01', tersedia);
    expect(hasil.ok).toBe(true);
    expect(hasil.functions).toEqual(['min']);
  });
});

/**
 * `if` harus malas.
 *
 * Regresi dari uji ujung-ke-ujung. Versi pertama mengevaluasi kedua cabang,
 * dengan alasan bahwa formula gaji tidak punya efek samping. Alasan itu salah:
 * pembagian nol adalah GALAT, bukan efek samping — dan menjaga terhadap
 * pembagi nol adalah alasan paling umum orang menulis `if` dalam formula gaji.
 *
 * Formula bawaan sendiri yang menemukannya:
 *   `if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)`
 * Dengan evaluasi penuh, penjaganya tidak pernah bekerja dan seluruh run gagal
 * untuk setiap karyawan yang belum punya rekap presensi.
 */
describe('evaluasi malas pada if', () => {
  it('tidak menghitung cabang yang tidak terpilih', () => {
    expect(
      hitung('if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA, 0)', {
        HARI_KERJA: 0,
        GAJI_POKOK: 8_000_000,
      }),
    ).toBe('0');
  });

  it('tetap menghitung cabang yang terpilih', () => {
    expect(
      hitung('if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA, 0)', {
        HARI_KERJA: 20,
        GAJI_POKOK: 8_000_000,
      }),
    ).toBe('400000');
  });

  it('menjaga terhadap pembagi nol pada cabang salah juga', () => {
    expect(hitung('if(0, 1/0, 42)')).toBe('42');
    expect(hitung('if(1, 42, 1/0)')).toBe('42');
  });

  it('tetap melempar bila cabang yang TERPILIH bermasalah', () => {
    // Kemalasan bukan pengampunan: cabang yang benar-benar dipakai tetap
    // diperiksa penuh.
    expect(() => hitung('if(1, 1/0, 42)')).toThrow(/Pembagian dengan nol/);
  });

  it('tetap memeriksa jumlah argumen', () => {
    expect(() => hitung('if(1, 2)')).toThrow(/membutuhkan 3 argumen/);
  });

  it('masih terdaftar sebagai fungsi yang tersedia', () => {
    expect(AVAILABLE_FUNCTIONS).toContain('if');
  });

  it('lolos pemeriksaan formula saat konfigurasi', () => {
    const hasil = checkFormula('if(A > 0, B / A, 0)', ['A', 'B']);
    expect(hasil.ok).toBe(true);
    expect(hasil.functions).toEqual(['if']);
  });
});
