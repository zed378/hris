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

describe('hari kerja mengikuti jadwal, bukan anggapan akhir pekan', () => {
  const kosong = new Set<string>();

  /** Jadwal pabrik enam hari: Minggu libur, Sabtu masuk. */
  function enamHari(dates: string[]): Map<string, boolean> {
    return new Map(dates.map((iso) => [iso, new Date(`${iso}T00:00:00Z`).getUTCDay() === 0]));
  }

  it('menghitung Sabtu sebagai hari kerja bila dijadwalkan masuk', () => {
    // 2027-01-04 Senin … 2027-01-09 Sabtu. Anggapan Senin–Jumat memberi 5;
    // pabrik enam hari kehilangan satu hari kerja setiap pengajuan seminggu,
    // dan angkanya tetap masuk akal sehingga tidak ada yang menyadarinya.
    const jadwal = enamHari([
      '2027-01-04', '2027-01-05', '2027-01-06',
      '2027-01-07', '2027-01-08', '2027-01-09',
    ]);
    expect(countWorkingDays(d('2027-01-04'), d('2027-01-09'), kosong)).toBe(5);
    expect(countWorkingDays(d('2027-01-04'), d('2027-01-09'), kosong, jadwal)).toBe(6);
  });

  it('tidak menghitung Senin yang dijadwalkan libur', () => {
    // Ritel yang tutup hari Senin.
    const jadwal = new Map([['2027-01-04', true]]);
    expect(countWorkingDays(d('2027-01-04'), d('2027-01-08'), kosong, jadwal)).toBe(4);
  });

  it('hari libur nasional tetap menang atas jadwal masuk', () => {
    // 17 Agustus 2027 jatuh hari Selasa. Dijadwalkan masuk, tetapi libur
    // nasional — dan cuti tidak boleh memotong saldo untuk hari yang memang
    // sudah libur bagi semua orang.
    const jadwal = new Map([['2027-08-17', false]]);
    const libur = new Set(['2027-08-17']);
    expect(countWorkingDays(d('2027-08-17'), d('2027-08-17'), libur, jadwal)).toBe(0);
  });

  it('tanggal tanpa baris jadwal jatuh ke anggapan Senin–Jumat', () => {
    // Tenant yang belum menjadwalkan apa pun tidak berubah perilakunya.
    const sebagian = new Map([['2027-01-09', false]]); // Sabtu, dijadwalkan masuk
    // Senin–Minggu: 5 hari kerja + Sabtu yang dijadwalkan = 6. Minggu tetap libur
    // karena tidak ada barisnya.
    expect(countWorkingDays(d('2027-01-04'), d('2027-01-10'), kosong, sebagian)).toBe(6);
  });
});
