import { writeAudit, type TenantClient } from '@hrms/db';
import { localMinutesToInstant, tenantTimeZone } from './workdate.ts';
import { leaveOnDate } from '../leave/index.ts';

/**
 * Kalkulasi presensi harian.
 *
 * Diturunkan dari `punch_logs` dan selalu dapat dihitung ulang. Hasilnya
 * disimpan karena dua alasan: rekap bulanan atas jutaan ketukan terlalu mahal
 * untuk dihitung setiap kali layar dibuka, dan payroll membutuhkan angka yang
 * berhenti berubah setelah periode ditutup.
 *
 * Sifat yang dijaga: **menghitung ulang hari yang sama harus menghasilkan angka
 * yang sama.** Tanpa itu, dua orang yang membuka rekap yang sama pada waktu
 * berbeda akan melihat gaji yang berbeda.
 */

export type DayStatus = 'PRESENT' | 'LATE' | 'ABSENT' | 'LEAVE' | 'HOLIDAY' | 'DAY_OFF';

export interface DailyResult {
  workDate: string;
  status: DayStatus;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
}

/**
 * Menghitung satu hari untuk satu karyawan.
 *
 * Ketukan yang DITOLAK peninjau dikecualikan; yang masih menunggu tinjauan tetap
 * dihitung. Itu pilihan sadar: menahan perhitungan sampai HR sempat meninjau
 * berarti rekap kosong pada hari-hari tersibuk, dan orang yang benar-benar hadir
 * terlihat tidak hadir sampai ada yang menekan tombol.
 */
export async function calculateDay(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  workDate: Date,
): Promise<DailyResult> {
  const dateOnly = new Date(
    Date.UTC(workDate.getUTCFullYear(), workDate.getUTCMonth(), workDate.getUTCDate()),
  );

  const timeZone = await tenantTimeZone(tx, tenantId);

  const [punches, schedule, holiday, leave] = await Promise.all([
    tx.punchLog.findMany({
      where: {
        tenantId,
        employeeId,
        workDate: dateOnly,
        review: { not: 'REJECTED' },
      },
      orderBy: { punchedAt: 'asc' },
      select: { type: true, punchedAt: true },
    }),
    tx.schedule.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: dateOnly } },
      select: {
        isDayOff: true,
        shiftId: true,
        shift: {
          select: { startMinute: true, endMinute: true, graceMinutes: true, breakMinutes: true },
        },
      },
    }),
    tx.holiday.findUnique({
      where: { tenantId_date: { tenantId, date: dateOnly } },
      select: { name: true },
    }),
    // Cuti dibaca lewat pintu depan modul cuti, bukan dengan query langsung ke
    // tabelnya: presensi tidak boleh tahu bentuk tabel cuti.
    leaveOnDate(tx, tenantId, employeeId, dateOnly),
  ]);

  const checkIn = punches.find((p) => p.type === 'IN')?.punchedAt ?? null;
  // Ketukan keluar TERAKHIR, bukan yang pertama. Orang yang keluar makan siang
  // lalu kembali menghasilkan dua ketukan OUT, dan yang menentukan jam pulang
  // adalah yang terakhir.
  const outs = punches.filter((p) => p.type === 'OUT');
  const checkOut = outs.length > 0 ? outs[outs.length - 1]!.punchedAt : null;

  const base = {
    workDate: dateOnly.toISOString().slice(0, 10),
    checkIn: checkIn?.toISOString() ?? null,
    checkOut: checkOut?.toISOString() ?? null,
    lateMinutes: 0,
    earlyMinutes: 0,
    workMinutes: 0,
    overtimeMinutes: 0,
  };

  // Urutan pemeriksaan menentukan hasilnya. Hari libur diperiksa lebih dulu
  // daripada jadwal: orang yang tetap masuk saat libur nasional tidak "terlambat",
  // ia lembur.
  if (holiday && !checkIn) return { ...base, status: 'HOLIDAY' };
  if (schedule?.isDayOff && !checkIn) return { ...base, status: 'DAY_OFF' };

  /**
   * Tanpa baris jadwal, akhir pekan tetap akhir pekan.
   *
   * Anggapan yang sama dipakai `countWorkingDays` pada modul cuti, dan
   * kesamaannya bukan kerapian: sebelum ini keduanya berbeda pendapat tentang
   * hari mana yang hari kerja. Cuti menganggap Sabtu dan Minggu bukan hari
   * kerja; presensi tidak menganggap apa pun, sehingga **setiap Minggu tercatat
   * ALFA** bagi tenant yang belum menjadwalkan siapa pun.
   *
   * Akibatnya tidak berhenti di layar rekap. `buildSnapshot` menghitung
   * `hariAlfa` dari status ALFA, dan formula gaji memotong berdasarkan angka
   * itu — sehingga akhir pekan menjadi potongan gaji. Kegagalannya tidak
   * menghasilkan galat apa pun; ia muncul sebagai slip gaji yang lebih kecil
   * dari yang seharusnya, pada orang yang tidak punya cara membuktikannya.
   *
   * Jadwal tetap menang bila ada — pabrik enam hari yang menjadwalkan Sabtu
   * masuk tidak terpengaruh anggapan ini, karena baris jadwalnya menjawab lebih
   * dulu di atas.
   */
  if (!schedule && !checkIn) {
    const weekday = dateOnly.getUTCDay();
    if (weekday === 0 || weekday === 6) return { ...base, status: 'DAY_OFF' };
  }

  /**
   * Cuti yang disetujui diperiksa SEBELUM alfa.
   *
   * Tanpa pemeriksaan ini, status `LEAVE` yang ada di tipe tidak pernah
   * dihasilkan siapa pun, dan karyawan yang cutinya sudah disetujui manajernya
   * tetap tercatat ABSENT — lalu dipotong gajinya sebagai mangkir. Kegagalannya
   * tidak menghasilkan galat apa pun; ia muncul sebagai slip gaji yang salah.
   *
   * Diletakkan setelah hari libur karena cuti yang jatuh pada hari libur bukan
   * cuti — jatahnya memang tidak dipotong untuk hari itu.
   */
  if (leave && !checkIn) return { ...base, status: 'LEAVE' };

  if (!checkIn) return { ...base, status: 'ABSENT' };

  const workMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60_000))
      : 0;

  const shift = schedule?.shift;

  if (!shift) {
    // Tanpa jadwal, tidak ada acuan untuk menilai terlambat atau lembur. Yang
    // dapat dikatakan hanyalah: orang ini hadir sekian menit.
    return { ...base, status: 'PRESENT', workMinutes };
  }

  // Menit jadwal adalah menit LOKAL. Menambahkannya ke tengah malam UTC akan
  // menggeser seluruh shift sebesar offset zona — untuk WIB, shift pagi menjadi
  // pukul 15:00, dan tidak ada seorang pun yang pernah tercatat terlambat.
  const scheduledStart = localMinutesToInstant(dateOnly, shift.startMinute, timeZone);
  const scheduledEnd = localMinutesToInstant(dateOnly, shift.endMinute, timeZone);

  const lateMinutes = Math.max(
    0,
    Math.round((checkIn.getTime() - scheduledStart.getTime()) / 60_000) - shift.graceMinutes,
  );

  const earlyMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((scheduledEnd.getTime() - checkOut.getTime()) / 60_000))
      : 0;

  const scheduledMinutes = shift.endMinute - shift.startMinute - shift.breakMinutes;
  const overtimeMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((checkOut.getTime() - scheduledEnd.getTime()) / 60_000))
      : 0;

  return {
    ...base,
    status: lateMinutes > 0 ? 'LATE' : 'PRESENT',
    lateMinutes,
    earlyMinutes,
    workMinutes: Math.max(0, workMinutes - (workMinutes > scheduledMinutes ? shift.breakMinutes : 0)),
    overtimeMinutes,
  };
}

/** Menyimpan hasil kalkulasi, kecuali hari itu sudah terkunci penutupan periode. */
export async function persistDay(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  result: DailyResult,
  shiftId: string | null,
): Promise<{ saved: boolean }> {
  const workDate = new Date(`${result.workDate}T00:00:00.000Z`);

  const existing = await tx.attendanceDay.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
    select: { id: true, isLocked: true },
  });

  // Hari yang terkunci tidak dihitung ulang. Setelah periode ditutup, angkanya
  // sudah masuk ke slip gaji — mengubahnya berarti slip yang terbit dan data
  // yang tersimpan tidak lagi cocok.
  if (existing?.isLocked) return { saved: false };

  const data = {
    tenantId,
    employeeId,
    workDate,
    shiftId,
    checkIn: result.checkIn ? new Date(result.checkIn) : null,
    checkOut: result.checkOut ? new Date(result.checkOut) : null,
    status: result.status,
    lateMinutes: result.lateMinutes,
    earlyMinutes: result.earlyMinutes,
    workMinutes: result.workMinutes,
    overtimeMinutes: result.overtimeMinutes,
  };

  await tx.attendanceDay.upsert({
    where: { employeeId_workDate: { employeeId, workDate } },
    create: data,
    update: data,
  });

  return { saved: true };
}

/** Menghitung ulang seluruh karyawan pada satu tanggal. */
export async function recalculateDate(
  tx: TenantClient,
  tenantId: string,
  workDate: Date,
): Promise<{ processed: number; skipped: number }> {
  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    select: { id: true },
  });

  let processed = 0;
  let skipped = 0;

  for (const employee of employees) {
    const saved = await recalculateEmployeeDate(tx, tenantId, employee.id, workDate);
    if (saved.saved) processed += 1;
    else skipped += 1;
  }

  return { processed, skipped };
}

/**
 * Menghitung ulang satu karyawan pada satu tanggal.
 *
 * Dipisahkan karena koreksi manual menyentuh tepat satu orang pada tepat satu
 * hari, sementara `recalculateDate` menyapu seluruh karyawan. Menjalankan sapuan
 * penuh setelah HR memperbaiki satu ketukan berarti menghitung ulang ribuan hari
 * yang tidak berubah — dan melakukannya di dalam request yang sedang ditunggu
 * orang.
 *
 * Mengembalikan `{ saved: false }` bila harinya terkunci penutupan periode.
 * Nilai itu wajib diteruskan ke pemanggil: koreksi yang tidak mengubah rekap
 * tidak boleh dilaporkan sebagai berhasil.
 */
export async function recalculateEmployeeDate(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  workDate: Date,
): Promise<{ saved: boolean }> {
  const result = await calculateDay(tx, tenantId, employeeId, workDate);
  const schedule = await tx.schedule.findUnique({
    where: {
      employeeId_workDate: {
        employeeId,
        workDate: new Date(`${result.workDate}T00:00:00.000Z`),
      },
    },
    select: { shiftId: true },
  });

  return persistDay(tx, tenantId, employeeId, result, schedule?.shiftId ?? null);
}

/**
 * Menutup periode presensi.
 *
 * Mengunci seluruh hari dalam rentang dan menyimpan ringkasannya. Setelah ini,
 * koreksi presensi yang masuk tidak lagi mengubah angka yang dipakai payroll —
 * dan itulah gunanya: slip gaji yang sudah terbit tidak boleh berubah karena
 * seseorang memperbaiki absensi bulan lalu.
 */
export async function closePeriod(
  tx: TenantClient,
  tenantId: string,
  year: number,
  month: number,
  actorUserId: string,
): Promise<{ employees: number; days: number }> {
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0));

  const days = await tx.attendanceDay.findMany({
    where: { tenantId, workDate: { gte: startDate, lte: endDate } },
    select: {
      employeeId: true,
      status: true,
      lateMinutes: true,
      workMinutes: true,
      overtimeMinutes: true,
    },
  });

  const summary = new Map<
    string,
    { present: number; late: number; absent: number; lateMinutes: number; overtimeMinutes: number }
  >();

  for (const day of days) {
    const row = summary.get(day.employeeId) ?? {
      present: 0,
      late: 0,
      absent: 0,
      lateMinutes: 0,
      overtimeMinutes: 0,
    };
    if (day.status === 'PRESENT' || day.status === 'LATE') row.present += 1;
    if (day.status === 'LATE') row.late += 1;
    if (day.status === 'ABSENT') row.absent += 1;
    row.lateMinutes += day.lateMinutes;
    row.overtimeMinutes += day.overtimeMinutes;
    summary.set(day.employeeId, row);
  }

  await tx.attendanceDay.updateMany({
    where: { tenantId, workDate: { gte: startDate, lte: endDate } },
    data: { isLocked: true },
  });

  await tx.attendancePeriod.upsert({
    where: { tenantId_year_month: { tenantId, year, month } },
    create: {
      tenantId,
      year,
      month,
      startDate,
      endDate,
      closedAt: new Date(),
      closedBy: actorUserId,
      snapshot: Object.fromEntries(summary) as never,
    },
    update: {
      closedAt: new Date(),
      closedBy: actorUserId,
      snapshot: Object.fromEntries(summary) as never,
    },
  });

  await writeAudit(tx, tenantId, {
    action: 'attendance.period.closed',
    entityType: 'attendance_period',
    entityId: `${year}-${String(month).padStart(2, '0')}`,
    actorUserId,
    after: { employees: summary.size, days: days.length },
  });

  return { employees: summary.size, days: days.length };
}

