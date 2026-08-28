import { describe, expect, it } from 'vitest';
import {
  detectDeviceColumns,
  inferPunchTypes,
  parseStatus,
  parseWallClock,
  type TimedPunch,
} from '../src/attendance/device-format.ts';

/**
 * Pembacaan berkas mesin absensi.
 *
 * Yang diuji di sini bukan kerapian parser, melainkan tiga cara berkas mesin
 * absensi salah dibaca TANPA menghasilkan galat apa pun: kolom yang tidak
 * dikenali sehingga diam-diam terlewat, tanggal `10/08/2026` yang dibaca sebagai
 * Oktober, dan urutan ketukan yang terbalik sehingga jam kerja menjadi nol.
 */

describe('pengenalan kolom', () => {
  it('mengenali ragam judul yang dipakai mesin di lapangan', () => {
    const zkteco = detectDeviceColumns(['No.', 'AC-No.', 'Name', 'Date/Time', 'Status']);
    expect(zkteco.index.employeeNumber).toBe(1);
    expect(zkteco.missing).toEqual([]);

    const indonesia = detectDeviceColumns(['PIN', 'Nama', 'Tanggal', 'Jam', 'Verifikasi']);
    expect(indonesia.index.employeeNumber).toBe(0);
    expect(indonesia.index.date).toBe(2);
    expect(indonesia.index.time).toBe(3);
    expect(indonesia.index.status).toBe(4);
    expect(indonesia.missing).toEqual([]);
  });

  it('menerima tanggal dan jam terpisah sebagai pengganti satu kolom waktu', () => {
    const split = detectDeviceColumns(['User ID', 'Tanggal', 'Jam']);
    expect(split.index.dateTime).toBe(-1);
    expect(split.missing).toEqual([]);
  });

  it('menolak berkas yang tidak punya kolom waktu sama sekali', () => {
    // Diam-diam melanjutkan akan menghasilkan impor yang "berhasil" tanpa satu
    // ketukan pun tersimpan.
    const broken = detectDeviceColumns(['PIN', 'Nama', 'Departemen']);
    expect(broken.missing).toHaveLength(1);
    expect(broken.missing[0]).toContain('waktu');
  });

  it('menyebutkan peran yang hilang, bukan sekadar menolak', () => {
    const empty = detectDeviceColumns(['Kolom A', 'Kolom B']);
    expect(empty.missing).toHaveLength(2);
    expect(empty.missing.join(' ')).toContain('PIN');
  });

  it('tidak menyerobot kolom yang sudah terisi', () => {
    // `ID` dan `PIN` sama-sama alias nomor karyawan. Yang pertama menang, dan
    // yang kedua tidak boleh menimpanya.
    const both = detectDeviceColumns(['ID', 'PIN', 'DateTime']);
    expect(both.index.employeeNumber).toBe(0);
  });
});

describe('pembacaan waktu', () => {
  it('membaca tahun-bulan-hari', () => {
    expect(parseWallClock('2026-08-10 08:05:00')).toEqual({
      year: 2026,
      month: 8,
      day: 10,
      hour: 8,
      minute: 5,
    });
  });

  it('membaca hari/bulan/tahun sebagai tanggal Indonesia', () => {
    // `10/08/2026` berarti 10 Agustus. Menebaknya sebagai 8 Oktober menghasilkan
    // tanggal yang SAH — sehingga tidak ada galat, hanya seluruh presensi bulan
    // itu tercatat pada bulan yang salah.
    expect(parseWallClock('10/08/2026 17:30')).toMatchObject({ month: 8, day: 10 });
    expect(parseWallClock('01/12/2026 08:00')).toMatchObject({ month: 12, day: 1 });
  });

  it('menggabungkan kolom tanggal dan jam yang terpisah', () => {
    expect(parseWallClock('2026-08-10', '08:05')).toMatchObject({ day: 10, hour: 8, minute: 5 });
  });

  it('menerima sel bertipe Date dari berkas Excel', () => {
    const cell = new Date(Date.UTC(2026, 7, 10, 8, 5));
    expect(parseWallClock(cell)).toMatchObject({ year: 2026, month: 8, day: 10, hour: 8 });
  });

  it('menolak sel yang tidak dapat dibaca alih-alih menebak', () => {
    expect(parseWallClock('')).toBeNull();
    expect(parseWallClock('kemarin pagi')).toBeNull();
    expect(parseWallClock('2026-08-10')).toBeNull(); // tanpa jam
    expect(parseWallClock('2026-13-40 08:00')).toBeNull();
    expect(parseWallClock('2026-08-10 25:00')).toBeNull();
  });
});

describe('kolom status', () => {
  it('menerjemahkan kode angka ZKTeco', () => {
    expect(parseStatus('0')).toBe('IN');
    expect(parseStatus('1')).toBe('OUT');
  });

  it('menerjemahkan kata dalam dua bahasa', () => {
    expect(parseStatus('Masuk')).toBe('IN');
    expect(parseStatus('C/In')).toBe('IN');
    expect(parseStatus('Pulang')).toBe('OUT');
  });

  it('mengembalikan null untuk status yang tidak dikenali', () => {
    // Menebak IN akan menghasilkan hari dengan dua jam masuk dan tanpa jam
    // pulang, yang lalu dihitung nol menit kerja.
    expect(parseStatus('Sidik Jari')).toBeNull();
    expect(parseStatus('')).toBeNull();
  });
});

describe('penentuan jenis ketukan', () => {
  const punch = (day: number, hour: number, minute = 0, employeeNumber = 'K-001'): TimedPunch => ({
    rowNumber: day * 100 + hour,
    employeeNumber,
    wallClock: { year: 2026, month: 8, day, hour, minute },
    declaredType: null,
  });

  it('menjadikan ketukan pertama tiap hari sebagai masuk', () => {
    const result = inferPunchTypes([punch(10, 17), punch(10, 8), punch(11, 8)]);
    expect(result.map((r) => `${r.wallClock.day}/${r.wallClock.hour} ${r.type}`)).toEqual([
      '10/8 IN',
      '10/17 OUT',
      '11/8 IN',
    ]);
  });

  it('tidak berselang-seling ketika ada tempelan jari yang terlewat', () => {
    // Inilah alasan aturannya bukan selang-seling. Satu ketukan hilang di tengah
    // hari — hal yang terjadi setiap hari — akan membalik SELURUH sisa hari itu
    // bila jenisnya ditentukan bergantian, mengubah jam pulang menjadi jam masuk.
    const result = inferPunchTypes([punch(10, 8), punch(10, 12), punch(10, 17)]);
    expect(result.map((r) => r.type)).toEqual(['IN', 'OUT', 'OUT']);

    // Kalkulasi harian mengambil IN pertama dan OUT terakhir, sehingga ketukan
    // tengah hari tidak mengubah jam kerja dan tetap tersimpan utuh.
    expect(result[0]!.wallClock.hour).toBe(8);
    expect(result[result.length - 1]!.wallClock.hour).toBe(17);
  });

  it('memisahkan hitungan per karyawan', () => {
    const result = inferPunchTypes([punch(10, 8, 0, 'K-001'), punch(10, 9, 0, 'K-002')]);
    expect(result.every((r) => r.type === 'IN')).toBe(true);
  });

  it('mendahulukan status dari mesin daripada urutan', () => {
    // Mesin yang menyatakan jenisnya lebih tahu daripada tebakan urutan.
    const declared: TimedPunch[] = [
      { ...punch(10, 8), declaredType: 'OUT' },
      { ...punch(10, 17), declaredType: 'IN' },
    ];
    expect(inferPunchTypes(declared).map((r) => r.type)).toEqual(['OUT', 'IN']);
  });

  it('mengurutkan ketukan meski berkasnya tidak berurutan', () => {
    // Ekspor mesin kerap terurut per karyawan, bukan per waktu.
    const result = inferPunchTypes([punch(10, 17), punch(10, 8)]);
    expect(result[0]!.wallClock.hour).toBe(8);
    expect(result[0]!.type).toBe('IN');
  });
});
