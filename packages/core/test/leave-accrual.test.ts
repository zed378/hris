import { Prisma } from '@hrms/db';
import { describe, expect, it } from 'vitest';
import { accruesOverTime, entitlementAsOf } from '../src/leave/accrual.ts';

/**
 * Perolehan jatah cuti menurut metode akrual.
 *
 * Bug yang ditutup uji ini: `MONTHLY_ACCRUAL` dan `ANNIVERSARY` ada di enum
 * sejak migrasi pertama dan dapat dipilih HR di layar jenis cuti, tetapi
 * `ensureBalance` memberikan kuota PENUH apa pun metodenya. Tidak ada galat —
 * angkanya sekadar salah, dan salahnya berpihak pada karyawan sehingga tidak
 * akan ada yang melaporkannya.
 */

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);
const hari = (v: Prisma.Decimal): number => Number(v);

describe('ANNUAL_GRANT', () => {
  it('memberi kuota penuh sejak awal tahun', () => {
    expect(
      hari(
        entitlementAsOf({
          method: 'ANNUAL_GRANT',
          quotaDays: dec(12),
          joinDate: d('2020-03-10'),
          periodYear: 2026,
          asOf: d('2026-01-01'),
        }),
      ),
    ).toBe(12);
  });

  it('penuh meski dinilai SEBELUM tahun periodenya mulai', () => {
    // `runCarryOver` membuat baris tahun berikutnya. Bila ia dijalankan pada
    // 31 Desember, penilaiannya jatuh sebelum awal periode baru — dan baris itu
    // harus tetap lahir dengan jatah penuh. Penjaga "tahunnya belum mulai" yang
    // berlaku untuk semua metode akan membuat seluruh perusahaan memulai tahun
    // tanpa jatah cuti, tanpa satu pun galat, dan tanpa satu pun jalur yang
    // akan memperbaikinya kemudian.
    expect(
      hari(
        entitlementAsOf({
          method: 'ANNUAL_GRANT',
          quotaDays: dec(12),
          joinDate: d('2020-03-10'),
          periodYear: 2027,
          asOf: d('2026-12-31'),
        }),
      ),
    ).toBe(12);
  });

  it('nol untuk tahun sebelum karyawan masuk', () => {
    expect(
      hari(
        entitlementAsOf({
          method: 'ANNUAL_GRANT',
          quotaDays: dec(12),
          joinDate: d('2027-01-05'),
          periodYear: 2026,
          asOf: d('2026-12-31'),
        }),
      ),
    ).toBe(0);
  });
});

describe('MONTHLY_ACCRUAL', () => {
  const bulanan = (joinDate: string, asOf: string, periodYear = 2026): number =>
    hari(
      entitlementAsOf({
        method: 'MONTHLY_ACCRUAL',
        quotaDays: dec(12),
        joinDate: d(joinDate),
        periodYear,
        asOf: d(asOf),
      }),
    );

  it('nol bila tahun periodenya belum mulai', () => {
    // Berbeda dari ANNUAL_GRANT: yang ditabung per bulan memang belum ada
    // apa-apanya sebelum tahunnya berjalan.
    expect(bulanan('2020-03-10', '2025-12-31')).toBe(0);
  });

  it('nol pada hari pertama masuk kerja', () => {
    // Inilah bug aslinya: sebelumnya di sini muncul 12 hari penuh, dan karyawan
    // dapat mengambil seluruhnya di bulan pertama lalu mengundurkan diri.
    expect(bulanan('2026-03-10', '2026-03-10')).toBe(0);
  });

  it('nol sehari sebelum ulang-bulan pertama', () => {
    expect(bulanan('2026-03-10', '2026-04-09')).toBe(0);
  });

  it('satu hari tepat pada ulang-bulan pertama', () => {
    expect(bulanan('2026-03-10', '2026-04-10')).toBe(1);
  });

  it('menabung satu per bulan sepanjang tahun', () => {
    expect(bulanan('2026-03-10', '2026-12-31')).toBe(9); // Apr–Des
  });

  it('karyawan lama memperoleh kuota penuh pada akhir tahun', () => {
    expect(bulanan('2020-03-10', '2026-12-31')).toBe(12);
  });

  it('memberi tepat dua belas bulan pada tahun penuh, apa pun tanggal masuknya', () => {
    // Tanggal masuk 1 adalah kasus batasnya: ulang-bulan 1 Januari harus IKUT
    // terhitung. Mengecualikannya membuat setiap karyawan bertanggal-masuk 1
    // kehilangan satu bulan setiap tahun — selisih satu hari jatah yang tidak
    // akan pernah dapat dijelaskan asalnya.
    for (const tanggal of ['01', '10', '15', '28', '31']) {
      const masuk = tanggal === '31' ? '2020-01-31' : `2020-01-${tanggal}`;
      expect(bulanan(masuk, '2026-12-31'), `masuk tanggal ${tanggal}`).toBe(12);
    }
  });

  it('tidak bertambah setelah tahun periodenya lewat', () => {
    // Membuka saldo 2026 pada tahun 2028 harus menampilkan jatah 2026, bukan
    // jatah dua tahun.
    expect(bulanan('2020-03-10', '2028-06-01')).toBe(12);
  });

  it('menjatuhkan tanggal 31 ke hari terakhir bulan pendek', () => {
    // Masuk 31 Januari: ulang-bulan Februari jatuh pada 28 (2026 bukan kabisat).
    // Melompat ke 1 Maret akan membuat bulan Februari orang itu tidak terhitung.
    expect(bulanan('2026-01-31', '2026-02-28')).toBe(1);
    expect(bulanan('2026-01-31', '2026-02-27')).toBe(0);
  });

  it('menangani tahun kabisat', () => {
    expect(bulanan('2024-01-31', '2024-02-29', 2024)).toBe(1);
  });

  it('pecahan kuota dibulatkan apa adanya, tidak dibulatkan ke bawah', () => {
    // Kuota 15 hari, 7 bulan → 8,75 hari. Membulatkannya ke 8 akan menghilangkan
    // tiga perempat hari milik karyawan tanpa dasar apa pun.
    const v = entitlementAsOf({
      method: 'MONTHLY_ACCRUAL',
      quotaDays: dec(15),
      joinDate: d('2026-01-10'),
      periodYear: 2026,
      asOf: d('2026-08-10'),
    });
    expect(hari(v)).toBeCloseTo(8.75, 5);
  });
});

describe('ANNIVERSARY', () => {
  const ulth = (joinDate: string, asOf: string, periodYear = 2026): number =>
    hari(
      entitlementAsOf({
        method: 'ANNIVERSARY',
        quotaDays: dec(12),
        joinDate: d(joinDate),
        periodYear,
        asOf: d(asOf),
      }),
    );

  it('nol sepanjang tahun pertama', () => {
    // UU Ketenagakerjaan Pasal 79 ayat (3): hak cuti tahunan timbul setelah 12
    // bulan bekerja terus-menerus. Sebelum perbaikan, orang yang baru bekerja
    // sebulan sudah punya 12 hari sejak 1 Januari.
    expect(ulth('2026-03-10', '2026-12-31')).toBe(0);
  });

  it('nol sehari sebelum ulang tahun masa kerja', () => {
    expect(ulth('2025-03-10', '2026-03-09')).toBe(0);
  });

  it('kuota penuh tepat pada ulang tahun masa kerja', () => {
    expect(ulth('2025-03-10', '2026-03-10')).toBe(12);
  });

  it('kuota penuh untuk karyawan lama setelah ulang tahunnya lewat', () => {
    expect(ulth('2018-03-10', '2026-07-01')).toBe(12);
  });

  it('menjatuhkan 29 Februari ke 28 pada tahun biasa', () => {
    expect(ulth('2024-02-29', '2026-02-28')).toBe(12);
    expect(ulth('2024-02-29', '2026-02-27')).toBe(0);
  });
});

describe('UNLIMITED dan NONE', () => {
  it('tidak berbasis kuota', () => {
    for (const method of ['UNLIMITED', 'NONE'] as const) {
      expect(
        hari(
          entitlementAsOf({
            method,
            quotaDays: dec(12),
            joinDate: d('2020-01-01'),
            periodYear: 2026,
            asOf: d('2026-06-01'),
          }),
        ),
      ).toBe(0);
    }
  });
});

describe('accruesOverTime', () => {
  it('hanya benar untuk metode yang tumbuh dalam tahun berjalan', () => {
    expect(accruesOverTime('MONTHLY_ACCRUAL')).toBe(true);
    expect(accruesOverTime('ANNIVERSARY')).toBe(true);
    // ANNUAL_GRANT sudah penuh sejak baris dibuat; memindainya tiap hari hanya
    // menghasilkan selisih nol.
    expect(accruesOverTime('ANNUAL_GRANT')).toBe(false);
    expect(accruesOverTime('UNLIMITED')).toBe(false);
    expect(accruesOverTime('NONE')).toBe(false);
  });
});
