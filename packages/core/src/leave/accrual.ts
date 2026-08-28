import { Prisma } from '@hrms/db';

/**
 * Perolehan jatah cuti menurut metode akrual (dokumen 03 §4.1).
 *
 * Berkas ini menutup bug dari kelas yang sudah berulang di proyek ini: **nilai
 * enum yang dideklarasikan tetapi tidak pernah diproduksi siapa pun.**
 *
 * `AccrualMethod` punya lima nilai sejak migrasi pertama modul cuti, dan layar
 * jenis cuti mengizinkan HR memilih kelimanya. Tetapi `ensureBalance` memberikan
 * `defaultQuotaDays` PENUH apa pun metodenya. Akibatnya, tenant yang memilih:
 *
 *   - `MONTHLY_ACCRUAL` — karyawan yang masuk 10 Maret langsung menerima 12 hari
 *     pada hari pertamanya, bukan menabung satu hari per bulan. Ia dapat
 *     mengambil seluruhnya di bulan April lalu mengundurkan diri di bulan Mei,
 *     dan perusahaan membayar cuti yang belum diperoleh.
 *   - `ANNIVERSARY` — jatah seharusnya lahir pada ulang tahun masa kerja, sesuai
 *     UU Ketenagakerjaan Pasal 79 ayat (3): hak cuti tahunan timbul setelah 12
 *     bulan bekerja terus-menerus. Yang terjadi, jatahnya ada sejak 1 Januari
 *     bagi orang yang baru bekerja sebulan.
 *
 * Tidak ada galat pada keduanya. Angkanya sekadar salah, dan salahnya berpihak
 * pada karyawan — sehingga tidak akan ada yang melaporkannya.
 *
 * ## Bentuk perbaikannya: target, bukan tambahan
 *
 * `entitlementAsOf` menjawab satu pertanyaan: **berapa hari yang SEHARUSNYA
 * sudah diperoleh orang ini pada tanggal ini.** Ia fungsi murni atas tanggal
 * masuk, bukan akumulasi dari pemanggilan sebelumnya.
 *
 * Konsekuensinya penting untuk job berkala: rekonsiliasi menjadi idempoten dan
 * memperbaiki dirinya sendiri. Menjalankannya dua kali sehari tidak menggandakan
 * apa pun, dan job yang mati selama tiga bulan mengejar ketertinggalannya dalam
 * satu putaran. Akrual yang menambah "satu bulan" setiap kali dipanggil punya
 * dua kegagalan sekaligus: dua kali jalan berarti dua kali jatah, dan sekali
 * terlewat berarti jatah yang hilang selamanya tanpa jejak.
 */

export type AccrualMethod =
  | 'ANNUAL_GRANT'
  | 'MONTHLY_ACCRUAL'
  | 'ANNIVERSARY'
  | 'UNLIMITED'
  | 'NONE';

const MONTHS_PER_YEAR = 12;

export interface EntitlementInput {
  method: AccrualMethod;
  /** Jatah setahun penuh menurut jenis cutinya. */
  quotaDays: Prisma.Decimal;
  /** Tanggal masuk kerja. Dasar seluruh perhitungan masa kerja. */
  joinDate: Date;
  /** Tahun kalender baris saldonya. */
  periodYear: number;
  /** Tanggal penilaian — biasanya hari ini. */
  asOf: Date;
}

/**
 * Berapa hari jatah yang sudah diperoleh pada `asOf`.
 *
 * Selalu dihitung dalam UTC. Perbedaan zona waktu bergeser paling banyak satu
 * hari pada batas bulan, dan untuk jatah cuti tahunan itu tidak mengubah
 * apa pun — berbeda dengan batas hari kerja presensi, yang bergeser setiap hari
 * bagi setiap orang dan karena itu memang memakai zona waktu tenant.
 */
export function entitlementAsOf(input: EntitlementInput): Prisma.Decimal {
  const { method, quotaDays, joinDate, periodYear, asOf } = input;

  // Tidak berbasis kuota. Barisnya tetap ada supaya mutasinya punya tempat.
  if (method === 'UNLIMITED' || method === 'NONE') return new Prisma.Decimal(0);

  const periodStart = Date.UTC(periodYear, 0, 1);
  const periodEnd = Date.UTC(periodYear, 11, 31);
  const join = utcMidnight(joinDate);
  const now = utcMidnight(asOf);

  // Belum masuk kerja saat tahun itu berakhir.
  if (join > periodEnd) return new Prisma.Decimal(0);

  // Jatah penuh untuk seluruh tahun periodenya, **tidak bergantung pada
  // `asOf`**. Ini perilaku yang sudah ada sejak awal dan sengaja TIDAK diubah
  // menjadi prorata: mengubahnya akan memotong jatah orang-orang yang saldonya
  // sudah terbentuk, dan prorata masuk-tengah-tahun adalah kebijakan tenant,
  // bukan koreksi bug.
  //
  // Ketidakbergantungan pada `asOf` itu penting, dan hampir hilang saat berkas
  // ini ditulis. `runCarryOver` membuat baris tahun BERIKUTNYA, dan bila
  // dijalankan pada 31 Desember maka `asOf` masih berada sebelum awal periode
  // barunya. Penjaga "tahunnya belum mulai" yang berlaku untuk semua metode
  // akan membuat baris itu lahir dengan jatah nol — dan karena `ANNUAL_GRANT`
  // tidak tumbuh seiring waktu, tidak ada satu pun jalur yang akan
  // memperbaikinya kemudian. Seluruh perusahaan memulai tahun tanpa jatah cuti,
  // tanpa satu pun galat, hanya karena penutupan tahun dijalankan sehari lebih
  // awal dari yang dibayangkan.
  if (method === 'ANNUAL_GRANT') return quotaDays;

  // Tahunnya belum mulai — tidak ada yang dapat ditabung.
  if (now < periodStart) return new Prisma.Decimal(0);

  // Penilaian tidak pernah melampaui akhir tahun periodenya. Tanpa batas ini,
  // membuka saldo 2026 pada tahun 2028 akan menampilkan jatah dua tahun.
  const evaluated = Math.min(now, periodEnd);

  switch (method) {

    case 'MONTHLY_ACCRUAL': {
      // Satu per dua belas jatah untuk setiap bulan masa kerja yang GENAP
      // terlewati di dalam tahun ini.
      //
      // Yang dihitung adalah ulang-bulan tanggal masuk, bukan akhir bulan
      // kalender. Karyawan yang masuk 10 Maret memperoleh jatah pertamanya
      // pada 10 April, bukan 31 Maret — sehingga orang yang masuk tanggal 28
      // tidak memperoleh hampir sebulan penuh secara cuma-cuma.
      const months = monthiversariesBetween(join, Math.max(periodStart, join), evaluated);

      // Batas dua belas bulan. Dengan penjepitan `from` ke awal tahun dan `to`
      // ke akhir tahun di atas, batas ini TIDAK PERNAH tercapai hari ini — dan
      // itu dinyatakan di sini alih-alih dibiarkan tampak seperti penjagaan
      // yang bekerja. Uji mutasi mengonfirmasinya: menghapus `Math.min` tidak
      // menggagalkan satu uji pun. Ia tetap dipasang karena yang menjaganya
      // adalah penjepitan di dua tempat lain, dan penjepitan itulah yang akan
      // dilonggarkan orang berikutnya yang menambahkan periode non-kalender.
      const capped = Math.min(months, MONTHS_PER_YEAR);
      return quotaDays.mul(capped).div(MONTHS_PER_YEAR);
    }

    case 'ANNIVERSARY': {
      // Jatah penuh lahir pada ulang tahun masa kerja, dan tidak sedetik pun
      // sebelum itu. Karyawan tahun pertama memperoleh NOL — persis yang
      // dimaksud UU Ketenagakerjaan Pasal 79 ayat (3).
      const anniversary = anniversaryIn(join, periodYear);
      if (anniversary === null) return new Prisma.Decimal(0);
      return evaluated >= anniversary ? quotaDays : new Prisma.Decimal(0);
    }
  }
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Berapa ulang-bulan tanggal masuk yang jatuh dalam [from, to].
 *
 * Batas bawahnya INKLUSIF, dan itu bukan detail: bagi karyawan lama, 1 Januari
 * adalah ulang-bulan yang sah bila ia masuk tanggal 1. Mengecualikannya membuat
 * setiap karyawan bertanggal-masuk 1 kehilangan satu bulan setiap tahun —
 * selisih satu hari jatah yang tidak akan pernah dapat dijelaskan asalnya.
 *
 * Tanggal masuk itu sendiri BUKAN ulang-bulan: hari pertama bekerja belum
 * memperoleh apa pun.
 *
 * Tanggal 31 pada bulan yang lebih pendek jatuh ke hari terakhir bulan itu —
 * masuk 31 Januari berulang-bulan pada 28 (atau 29) Februari. Alternatifnya,
 * melompat ke 1 Maret, akan membuat bulan Februari seseorang tidak pernah
 * terhitung pada tahun tertentu.
 */
function monthiversariesBetween(join: number, from: number, to: number): number {
  const joinDay = new Date(join).getUTCDate();
  const start = new Date(from);

  let cursor = clampedMonthiversary(start.getUTCFullYear(), start.getUTCMonth(), joinDay);

  // Mundur sebulan bila ulang-bulan bulan ini jatuh sebelum `from`, supaya
  // putaran berikutnya tidak melewatkannya.
  while (cursor < from) {
    const c = new Date(cursor);
    cursor = clampedMonthiversary(c.getUTCFullYear(), c.getUTCMonth() + 1, joinDay);
  }

  let count = 0;
  while (cursor <= to) {
    // Hari pertama bekerja bukan ulang-bulan.
    if (cursor > join) count += 1;
    const c = new Date(cursor);
    cursor = clampedMonthiversary(c.getUTCFullYear(), c.getUTCMonth() + 1, joinDay);
  }

  return count;
}

function clampedMonthiversary(year: number, month: number, day: number): number {
  // `month` boleh 12 atau lebih; Date.UTC menggulungnya ke tahun berikutnya.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, lastDay));
}

/**
 * Ulang tahun masa kerja yang jatuh pada tahun kalender tertentu.
 *
 * `null` bila karyawan belum genap setahun bekerja pada tahun itu — ulang tahun
 * ke-nol bukan ulang tahun.
 */
function anniversaryIn(join: number, periodYear: number): number | null {
  const joinDate = new Date(join);
  if (joinDate.getUTCFullYear() >= periodYear) return null;
  return clampedMonthiversary(periodYear, joinDate.getUTCMonth(), joinDate.getUTCDate());
}

/**
 * Apakah metodenya bertambah seiring waktu di dalam satu tahun berjalan.
 *
 * Dipakai job berkala untuk menyaring baris yang perlu ditinjau ulang.
 * `ANNUAL_GRANT` tidak termasuk: jatahnya sudah penuh sejak baris dibuat, dan
 * memindainya setiap hari hanya menghasilkan selisih nol.
 */
export function accruesOverTime(method: AccrualMethod): boolean {
  return method === 'MONTHLY_ACCRUAL' || method === 'ANNIVERSARY';
}
