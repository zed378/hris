import { type TenantClient } from '@hrms/db';

/**
 * Pembangkit jadwal kerja (dokumen 10 §5).
 *
 * Tabel `attendance.schedules` sudah dibaca dua modul sejak awal — presensi
 * memakainya untuk memutuskan status `DAY_OFF`, dan cuti untuk menghitung hari
 * kerja — tetapi **tidak ada satu pun yang mengisinya.** Akibatnya kedua modul
 * jatuh ke anggapan Senin–Jumat, dan anggapan itu salah untuk sebagian besar
 * tenant yang dituju produk ini: pabrik enam hari kerja, ritel yang libur hari
 * Senin, satpam tiga shift yang liburnya berputar.
 *
 * Berkas ini yang mengisinya, dari sebuah pola mingguan.
 *
 * ## Tiga hal yang sengaja TIDAK dilakukan
 *
 * **Tidak menimpa baris yang sudah ada, kecuali diminta.** Jadwal yang sudah ada
 * mungkin hasil penyesuaian tangan — tukar shift antar-karyawan, libur pengganti
 * yang sudah disepakati. Membangkitkan ulang sebulan lalu menghapus diam-diam
 * kesepakatan itu adalah cara kehilangan kepercayaan pada fitur penjadwalan
 * dalam satu kali pakai.
 *
 * **Tidak menjadwalkan di luar masa kerja.** Karyawan yang mengundurkan diri
 * bulan Maret tetapi punya jadwal sampai Desember akan tercatat ALFA setiap hari
 * sampai akhir tahun, dan angka kehadiran seluruh perusahaan ikut rusak.
 *
 * **Tidak menandai hari libur nasional sebagai libur mingguan.** Presensi sudah
 * memeriksa `holidays` lebih dulu daripada jadwal, dan urutan itu disengaja:
 * orang yang tetap masuk saat libur nasional tidak "terlambat", ia lembur.
 * Menuliskannya sebagai `is_day_off` akan menukar status HOLIDAY menjadi
 * DAY_OFF, dan lembur hari libur menjadi tidak terlihat.
 */

/** 0 = Minggu, 6 = Sabtu — sama dengan `Date#getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly kind: 'range_too_long' | 'invalid_range' | 'all_days_off' | 'not_found',
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/**
 * Batas rentang sekali bangkit.
 *
 * Setahun, bukan lima. 500 karyawan × 5 tahun adalah 900 ribu baris dalam satu
 * transaksi — dan kesalahan pola pada pembangkitan seperti itu jauh lebih mahal
 * untuk dibatalkan daripada untuk dicegah.
 */
export const MAX_RANGE_DAYS = 366;

export interface GenerateInput {
  employeeIds: string[];
  startDate: Date;
  endDate: Date;
  /** Shift untuk hari masuk. `null` berarti tanpa shift tetap. */
  shiftId: string | null;
  /** Hari libur mingguan. Senin–Jumat biasa = [0, 6]. */
  dayOffWeekdays: readonly Weekday[];
  /** Timpa baris yang sudah ada. Default: lewati dan laporkan. */
  overwrite?: boolean;
}

export interface GenerateResult {
  created: number;
  updated: number;
  /** Baris yang sudah ada dan TIDAK ditimpa. */
  skipped: number;
  /** Tanggal di luar masa kerja karyawan, tidak dijadwalkan. */
  outsideEmployment: number;
  employees: number;
}

export async function generateSchedules(
  tx: TenantClient,
  tenantId: string,
  input: GenerateInput,
): Promise<GenerateResult> {
  const start = utcDate(input.startDate);
  const end = utcDate(input.endDate);

  if (end < start) {
    throw new ScheduleError('Tanggal selesai mendahului tanggal mulai', 'invalid_range');
  }

  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ScheduleError(
      `Rentang ${days} hari melampaui batas ${MAX_RANGE_DAYS} hari sekali bangkit.`,
      'range_too_long',
    );
  }

  const dayOff = new Set<number>(input.dayOffWeekdays);
  if (dayOff.size >= 7) {
    // Tujuh hari libur bukan jadwal; ia cara menandai seseorang tidak bekerja
    // sama sekali, dan jalurnya adalah menonaktifkan karyawan, bukan menjadwal.
    throw new ScheduleError('Seluruh hari ditandai libur — tidak ada hari kerja', 'all_days_off');
  }

  if (input.shiftId) {
    const shift = await tx.shift.findFirst({
      where: { id: input.shiftId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!shift) throw new ScheduleError('Shift tidak ditemukan atau tidak aktif', 'not_found');
  }

  const employees = await tx.employee.findMany({
    where: { id: { in: input.employeeIds }, tenantId },
    select: { id: true, joinDate: true, resignDate: true },
  });
  if (employees.length === 0) {
    throw new ScheduleError('Tidak ada karyawan yang cocok', 'not_found');
  }

  const result: GenerateResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    outsideEmployment: 0,
    employees: employees.length,
  };

  // Baris yang sudah ada dibaca sekali untuk seluruh rentang, bukan sekali per
  // tanggal. 500 karyawan × 366 hari adalah 183 ribu query bila diperiksa satu
  // per satu — dan seluruhnya di dalam satu transaksi yang memegang lock.
  const existing = await tx.schedule.findMany({
    where: {
      tenantId,
      employeeId: { in: employees.map((e) => e.id) },
      workDate: { gte: start, lte: end },
    },
    select: { id: true, employeeId: true, workDate: true },
  });
  const existingByKey = new Map(
    existing.map((s) => [`${s.employeeId}:${s.workDate.toISOString().slice(0, 10)}`, s.id]),
  );

  const toCreate: Array<{
    tenantId: string;
    employeeId: string;
    workDate: Date;
    shiftId: string | null;
    isDayOff: boolean;
  }> = [];

  for (const employee of employees) {
    const joined = utcDate(employee.joinDate);
    const resigned = employee.resignDate ? utcDate(employee.resignDate) : null;

    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      const date = new Date(t);

      if (date < joined || (resigned && date > resigned)) {
        result.outsideEmployment += 1;
        continue;
      }

      const isDayOff = dayOff.has(date.getUTCDay());
      const key = `${employee.id}:${date.toISOString().slice(0, 10)}`;
      const existingId = existingByKey.get(key);

      if (existingId) {
        if (!input.overwrite) {
          result.skipped += 1;
          continue;
        }
        await tx.schedule.update({
          where: { id: existingId },
          data: { shiftId: isDayOff ? null : input.shiftId, isDayOff },
        });
        result.updated += 1;
        continue;
      }

      toCreate.push({
        tenantId,
        employeeId: employee.id,
        workDate: date,
        // Hari libur tidak membawa shift. Shift pada hari libur adalah keadaan
        // yang tidak dapat dijelaskan, dan `daily.ts` membacanya untuk
        // menghitung keterlambatan pada hari yang tidak ada jam masuknya.
        shiftId: isDayOff ? null : input.shiftId,
        isDayOff,
      });
    }
  }

  if (toCreate.length > 0) {
    const inserted = await tx.schedule.createMany({ data: toCreate, skipDuplicates: true });
    result.created = inserted.count;
  }

  return result;
}

function utcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
