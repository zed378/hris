import { describe, expect, it } from 'vitest';
import { countWorkingDays } from '../src/leave/requests.ts';

/**
 * Perhitungan hari kerja cuti.
 *
 * Angka inilah yang dipotong dari saldo seseorang. Salah menghitungnya bukan
 * ketidaknyamanan: karyawan yang cutinya Jumat sampai Senin dipotong empat hari
 * alih-alih dua akan kehilangan dua hari jatah setiap kali, dan ia tidak punya
 * cara membuktikannya selain menghitung sendiri.
 */

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const kosong = new Set<string>();

describe('perhitungan hari kerja', () => {
  it('menghitung satu hari untuk rentang satu hari', () => {
    // 4 Januari 2027 adalah Senin.
    expect(countWorkingDays(d('2027-01-04'), d('2027-01-04'), kosong)).toBe(1);
  });

  it('melewati akhir pekan di tengah rentang', () => {
    // Jumat 8 sampai Senin 11 Januari: empat hari kalender, dua hari kerja.
    expect(countWorkingDays(d('2027-01-08'), d('2027-01-11'), kosong)).toBe(2);
  });

  it('mengembalikan nol untuk rentang yang seluruhnya akhir pekan', () => {
    // Nol harus terdeteksi pemanggil dan ditolak — cuti nol hari yang tersimpan
    // menahan saldo nol tetapi tetap memblokir tanggalnya lewat constraint
    // tumpang tindih.
    expect(countWorkingDays(d('2027-01-09'), d('2027-01-10'), kosong)).toBe(0);
  });

  it('melewati hari libur nasional', () => {
    // 17 Agustus 2027 jatuh pada hari Selasa.
    const libur = new Set(['2027-08-17']);
    expect(countWorkingDays(d('2027-08-16'), d('2027-08-18'), kosong)).toBe(3);
    expect(countWorkingDays(d('2027-08-16'), d('2027-08-18'), libur)).toBe(2);
  });

  it('tidak menghitung ganda hari libur yang jatuh di akhir pekan', () => {
    // Hari libur yang jatuh Sabtu tidak mengurangi apa pun — ia sudah bukan
    // hari kerja. Mengurangkannya dua kali akan memberi karyawan satu hari
    // gratis setiap tahun tanpa ada yang memutuskan begitu.
    const libur = new Set(['2027-01-09']); // Sabtu
    expect(countWorkingDays(d('2027-01-08'), d('2027-01-11'), libur)).toBe(2);
  });

  it('menghitung rentang panjang lintas bulan', () => {
    // 25 Januari (Senin) sampai 5 Februari (Jumat) 2027: dua pekan penuh.
    expect(countWorkingDays(d('2027-01-25'), d('2027-02-05'), kosong)).toBe(10);
  });

  it('menghitung rentang lintas tahun', () => {
    // 30 Desember 2026 (Rabu) sampai 4 Januari 2027 (Senin).
    const libur = new Set(['2027-01-01']); // Jumat, Tahun Baru
    expect(countWorkingDays(d('2026-12-30'), d('2027-01-04'), libur)).toBe(3);
  });
});
