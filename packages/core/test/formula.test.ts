import { describe, expect, it } from 'vitest';
import { Prisma } from '@hrms/db';
import {
  evaluateFormula,
  checkFormula,
  FormulaError,
  AVAILABLE_FUNCTIONS,
} from '../src/payroll/formula.ts';

/**
 * The salary formula parser.
 *
 * Two things are tested here, and both decide whether the payroll module is fit
 * to run at all:
 *
 *   1. **There is no route to code execution.** Formulas are written by a
 *      tenant's HR admin through a web interface. One gap here means every
 *      tenant admin holds arbitrary code execution on the server holding every
 *      other tenant's salary data.
 *   2. **Decimal arithmetic, not float.** The Phase 5 DoD demands a match down
 *      to the rupiah, and `0.1 + 0.2` in IEEE-754 does not equal `0.3`.
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
    // This is why Decimal is used. `0.1 + 0.2` in ordinary JavaScript gives
    // 0.30000000000000004, and that difference becomes rupiah nobody can explain
    // on a payslip.
    expect(hitung('0.1 + 0.2')).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('menghitung potongan gaji tanpa pembulatan yang menyimpang', () => {
    // BPJS Kesehatan at 1% of wages, with a 12 million ceiling.
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
    // This is the most important test in this file. A mistyped variable name
    // treated as zero produces a wrong payslip without one complaint — and that
    // zero looks like a decision rather than a mistake.
    expect(() => hitung('TUNJANGAN_TRANSPOT * 22', { TUNJANGAN_TRANSPOR: 25_000 })).toThrow(
      FormulaError,
    );
  });

  it('menyebutkan variabel yang tersedia dalam pesan galatnya', () => {
    // A message that only says "unknown variable" forces the admin to guess.
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
    // The salary calculation convention. ROUND_HALF_EVEN would round 2.5 down to
    // 2, and that one-rupiah difference fails the golden regression tests.
    expect(hitung('round(2.5, 0)')).toBe('3');
    expect(hitung('round(1234.567, 2)')).toBe('1234.57');
  });

  it('memilih cabang dengan if', () => {
    expect(hitung('if(MASA_KERJA >= 12, 1000000, 0)', { MASA_KERJA: 18 })).toBe('1000000');
    expect(hitung('if(MASA_KERJA >= 12, 1000000, 0)', { MASA_KERJA: 6 })).toBe('0');
  });

  it('menolak fungsi yang tidak ada dalam daftar putih', () => {
    // Including the ones that sound harmless. An allowlist closes the whole
    // surface at once; a blocklist is always one name behind.
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
    // There is no path from this parser to any JavaScript object: a variable is
    // only looked up in the scope the caller provided, and a function call only
    // in the allowlist.
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
    // An Infinity flowing into a payslip is worse than a run that stops and says
    // the formula is wrong.
    expect(() => hitung('100 / 0')).toThrow(/Pembagian dengan nol/);
    expect(() => hitung('100 / (A - A)', { A: 5 })).toThrow(FormulaError);
  });

  it('menolak titik sebagai pemisah ribuan', () => {
    // `1.000.000` is typed by someone used to the Indonesian format. Accepting it
    // as NaN would propagate NaN all the way to the payslip.
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
    // A bad formula has to be refused on the configuration screen. Finding it
    // during a run means finding it on the 25th, when a thousand payslips are due
    // tomorrow morning.
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
 * `if` has to be lazy.
 *
 * A regression from an end-to-end test. The first version evaluated both
 * branches, on the grounds that a salary formula has no side effects. That
 * reasoning was wrong: division by zero is an ERROR, not a side effect — and
 * guarding against a zero divisor is the most common reason anyone writes `if`
 * in a salary formula.
 *
 * The built-in formula found it itself:
 *   `if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)`
 * With full evaluation its guard never worked and the whole run failed for every
 * employee with no attendance recap yet.
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
    // Laziness is not leniency: the branch genuinely used is still fully checked.
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
