import { describe, expect, it } from 'vitest';
import { orderComponents } from '../src/payroll/components.ts';

/**
 * Urutan hitung komponen gaji.
 *
 * Yang diuji di sini adalah kegagalan yang tidak menghasilkan galat: komponen
 * yang dihitung SEBELUM komponen yang menjadi dasarnya membaca nilai nol, dan
 * nol itu masuk ke slip gaji sebagai angka yang terlihat seperti keputusan.
 *
 * `sortOrder` yang ditetapkan admin tidak dapat dipercaya untuk ini. Admin yang
 * menambahkan tunjangan baru di urutan 10 tanpa menyadari ia dipakai potongan
 * di urutan 5 tidak akan melihat galat apa pun — hanya potongan yang tiba-tiba
 * menjadi nol rupiah.
 */

type Component = {
  code: string;
  calcMethod: string;
  expression: string | null;
  baseComponentCode: string | null;
  sortOrder: number;
};

const c = (
  code: string,
  sortOrder: number,
  extra: Partial<Component> = {},
): Component => ({
  code,
  calcMethod: 'FIXED',
  expression: null,
  baseComponentCode: null,
  sortOrder,
  ...extra,
});

const kodeUrut = (components: Component[]): string[] =>
  orderComponents(components).map((component) => component.code);

describe('urutan ketergantungan komponen', () => {
  it('mempertahankan sortOrder ketika tidak ada ketergantungan', () => {
    expect(kodeUrut([c('TUNJANGAN', 20), c('POKOK', 10)])).toEqual(['POKOK', 'TUNJANGAN']);
  });

  it('mendahulukan dasar persentase meski sortOrder-nya belakangan', () => {
    // Inilah bug yang dicegah: BPJS 1% dari POKOK diberi urutan 5, POKOK diberi
    // urutan 10. Tanpa penataan ulang, BPJS dihitung dari nol.
    const urutan = kodeUrut([
      c('BPJS', 5, { calcMethod: 'PERCENTAGE', baseComponentCode: 'POKOK' }),
      c('POKOK', 10),
    ]);
    expect(urutan.indexOf('POKOK')).toBeLessThan(urutan.indexOf('BPJS'));
  });

  it('mendahulukan variabel yang dirujuk formula', () => {
    const urutan = kodeUrut([
      c('TOTAL', 1, { calcMethod: 'FORMULA', expression: 'POKOK + TUNJANGAN' }),
      c('POKOK', 50),
      c('TUNJANGAN', 60),
    ]);
    expect(urutan.indexOf('POKOK')).toBeLessThan(urutan.indexOf('TOTAL'));
    expect(urutan.indexOf('TUNJANGAN')).toBeLessThan(urutan.indexOf('TOTAL'));
  });

  it('menata rantai ketergantungan berlapis', () => {
    const urutan = kodeUrut([
      c('C', 1, { calcMethod: 'FORMULA', expression: 'B * 2' }),
      c('B', 2, { calcMethod: 'FORMULA', expression: 'A + 100' }),
      c('A', 3),
    ]);
    expect(urutan).toEqual(['A', 'B', 'C']);
  });

  it('mengabaikan variabel dasar yang bukan komponen', () => {
    // `HARI_HADIR` berasal dari potret presensi, bukan komponen lain. Ia tidak
    // boleh diperlakukan sebagai ketergantungan yang harus diurutkan.
    const urutan = kodeUrut([
      c('POTONGAN', 1, { calcMethod: 'FORMULA', expression: 'HARI_ALFA * 100000' }),
      c('POKOK', 2),
    ]);
    expect(urutan).toEqual(['POTONGAN', 'POKOK']);
  });

  it('tidak menggandakan komponen yang dirujuk beberapa kali', () => {
    const urutan = kodeUrut([
      c('X', 1, { calcMethod: 'FORMULA', expression: 'POKOK * 0.1' }),
      c('Y', 2, { calcMethod: 'FORMULA', expression: 'POKOK * 0.2' }),
      c('POKOK', 3),
    ]);
    expect(urutan).toHaveLength(3);
    expect(new Set(urutan).size).toBe(3);
  });

  it('tetap mengembalikan seluruh komponen meski formulanya tidak dapat diurai', () => {
    // Formula rusak sudah ditolak saat disimpan. Bila toh ada yang lolos —
    // misalnya dari data lama — penataan urutan tidak boleh ikut gagal dan
    // menghapus komponen lain dari slip.
    const urutan = kodeUrut([
      c('RUSAK', 1, { calcMethod: 'FORMULA', expression: '((( ' }),
      c('POKOK', 2),
    ]);
    expect(urutan.sort()).toEqual(['POKOK', 'RUSAK']);
  });
});
