import { describe, expect, it } from 'vitest';
import {
  localMinutesToInstant,
  resolveWorkDate,
  zonedDateString,
  zonedParts,
} from '../src/attendance/workdate.ts';

/**
 * Batas hari kerja.
 *
 * Bug yang ditutup uji ini bukan kasus tepi. Versi pertama menghitung batas hari
 * dengan `getUTCHours() < 4`, dan untuk WIB (UTC+7) itu berarti setiap ketukan
 * antara 06:00 dan 10:59 pagi mendarat pada tanggal KEMARIN — jendela kedatangan
 * hampir seluruh angkatan kerja Indonesia.
 *
 * Akibatnya berantai: setiap hari kerja hanya punya ketukan pulang, setiap hari
 * dihitung ABSENT, dan setiap potongan gaji yang mengikutinya salah. Tidak satu
 * pun galat muncul — angkanya hanya salah, terus-menerus, untuk semua orang.
 */

const WIB = 'Asia/Jakarta'; // UTC+7
const WIT = 'Asia/Jayapura'; // UTC+9

/** Membangun instan dari jam dinding WIB. */
function wib(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, day, hour - 7, minute));
}

describe('tanggal kerja pada zona tenant', () => {
  it('menempatkan seluruh jam kedatangan pagi pada tanggal yang benar', () => {
    // Inilah regresi yang sesungguhnya. Semua jam ini pernah menghasilkan 08-09.
    for (const hour of [6, 7, 8, 9, 10, 11]) {
      expect(resolveWorkDate(wib(10, hour), WIB).toISOString().slice(0, 10)).toBe('2026-08-10');
    }
  });

  it('menempatkan jam kerja siang dan malam pada tanggal yang sama', () => {
    for (const hour of [12, 15, 17, 20, 22, 23]) {
      expect(resolveWorkDate(wib(10, hour), WIB).toISOString().slice(0, 10)).toBe('2026-08-10');
    }
  });

  it('mengembalikan ketukan dini hari ke hari kerja sebelumnya', () => {
    // Shift malam 22:00-06:00: ketukan pulang pukul 02:00 masih milik shift yang
    // dimulai kemarin, dan harus dihitung pada hari kerja kemarin.
    expect(resolveWorkDate(wib(11, 1), WIB).toISOString().slice(0, 10)).toBe('2026-08-10');
    expect(resolveWorkDate(wib(11, 3, 59), WIB).toISOString().slice(0, 10)).toBe('2026-08-10');

    // Pukul 04:00 adalah ambangnya — sudah menjadi hari baru.
    expect(resolveWorkDate(wib(11, 4), WIB).toISOString().slice(0, 10)).toBe('2026-08-11');
  });

  it('menghormati zona tenant, bukan zona server', () => {
    // Satu instan yang sama, dua tenant di zona berbeda. 2026-08-10T16:30Z
    // adalah 23:30 di Jakarta tetapi sudah 01:30 tanggal 11 di Jayapura — dan
    // pukul 01:30 itu masih milik hari kerja tanggal 10 karena shift malam.
    const instant = new Date(Date.UTC(2026, 7, 10, 16, 30));

    expect(zonedDateString(instant, WIB)).toBe('2026-08-10');
    expect(zonedDateString(instant, WIT)).toBe('2026-08-11');
    expect(resolveWorkDate(instant, WIT).toISOString().slice(0, 10)).toBe('2026-08-10');
  });

  it('membaca tengah malam lokal sebagai jam 0, bukan 24', () => {
    // Sebagian runtime melaporkan tengah malam sebagai "24" pada hour12: false.
    // Bila lolos, tengah malam akan lebih besar dari ambang shift malam dan
    // ketukannya berpindah hari.
    expect(zonedParts(wib(10, 0), WIB).hour).toBe(0);
    expect(resolveWorkDate(wib(10, 0), WIB).toISOString().slice(0, 10)).toBe('2026-08-09');
  });
});

describe('jam jadwal shift', () => {
  const workDate = new Date(Date.UTC(2026, 7, 10));

  it('menempatkan shift pagi pada 08:00 waktu setempat, bukan 08:00 UTC', () => {
    // 480 menit sejak tengah malam = 08:00. Versi pertama menambahkannya ke
    // tengah malam UTC dan menghasilkan 15:00 WIB — sehingga ketukan pukul 08:05
    // terlihat tujuh jam LEBIH AWAL dari jadwal, dan keterlambatan tidak pernah
    // terdeteksi oleh siapa pun.
    const start = localMinutesToInstant(workDate, 480, WIB);

    expect(start.toISOString()).toBe('2026-08-10T01:00:00.000Z');
    expect(zonedParts(start, WIB).hour).toBe(8);
  });

  it('menghitung keterlambatan dengan tanda yang benar', () => {
    const start = localMinutesToInstant(workDate, 480, WIB);
    const arrival = wib(10, 8, 25);

    const lateMinutes = Math.round((arrival.getTime() - start.getTime()) / 60_000);
    expect(lateMinutes).toBe(25);
  });

  it('menempatkan shift yang sama pada instan berbeda di zona berbeda', () => {
    const jakarta = localMinutesToInstant(workDate, 480, WIB);
    const jayapura = localMinutesToInstant(workDate, 480, WIT);

    // Keduanya pukul 08:00 setempat, dan karena itu terpisah dua jam.
    expect(jayapura.getTime() - jakarta.getTime()).toBe(-2 * 3_600_000);
    expect(zonedParts(jayapura, WIT).hour).toBe(8);
  });

  it('menyatakan shift malam yang melewati tengah malam', () => {
    // 22:00 sampai 06:00 dinyatakan 1320 sampai 1800 — melewati 1440 dengan
    // sengaja, supaya akhir shift tidak perlu membawa tanggalnya sendiri.
    const start = localMinutesToInstant(workDate, 1320, WIB);
    const end = localMinutesToInstant(workDate, 1800, WIB);

    expect(zonedParts(start, WIB)).toMatchObject({ day: 10, hour: 22 });
    expect(zonedParts(end, WIB)).toMatchObject({ day: 11, hour: 6 });
    expect(end.getTime() - start.getTime()).toBe(8 * 3_600_000);
  });
});
