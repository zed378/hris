import { writeAudit, type TenantClient } from '@hrms/db';

/**
 * Rekap presensi bulanan per karyawan (dokumen 02 §9).
 *
 * Ini laporan yang benar-benar dicetak, ditandatangani, dan diarsipkan setiap
 * bulan di perusahaan Indonesia — satu baris per karyawan, berisi jumlah hadir,
 * terlambat, alfa, dan cuti. Ia juga yang dipakai bagian keuangan untuk
 * memeriksa potongan sebelum payroll dijalankan.
 *
 * Sebelum ini, yang ada hanyalah **daftar hari** — satu baris per karyawan per
 * tanggal. Untuk 100 karyawan sebulan itu 3.000 baris, dan HR yang membutuhkan
 * 100 angka menjumlahkannya sendiri di Excel. Penjumlahan tangan adalah tempat
 * angka berubah tanpa ada yang tahu, dan angka yang berubah di sini menjadi
 * potongan gaji.
 *
 * ## Yang dihitung, dan yang sengaja tidak
 *
 * **Hari tanpa baris tidak dihitung sebagai apa pun.** Rekap presensi dibuat
 * saat dihitung, bukan otomatis setiap malam, sehingga bulan yang belum
 * dihitung ulang akan punya lebih sedikit baris daripada jumlah harinya. Angka
 * `hariTercatat` dikembalikan supaya selisih itu terlihat — laporan yang
 * menampilkan "0 alfa" untuk bulan yang belum dihitung terbaca seperti bulan
 * yang sempurna.
 */

export interface MonthlyAttendanceRow {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  hadir: number;
  terlambat: number;
  alfa: number;
  cuti: number;
  libur: number;
  liburMingguan: number;
  /** Hari yang punya baris rekap. Lebih kecil dari jumlah hari berarti belum dihitung penuh. */
  hariTercatat: number;
  menitTerlambat: number;
  menitLembur: number;
  jamKerja: number;
}

export interface MonthlyAttendanceReport {
  periodYear: number;
  periodMonth: number;
  /** Jumlah hari kalender pada bulan itu. */
  hariKalender: number;
  rows: MonthlyAttendanceRow[];
  totals: {
    karyawan: number;
    hadir: number;
    terlambat: number;
    alfa: number;
    cuti: number;
    menitTerlambat: number;
    menitLembur: number;
  };
  /**
   * Karyawan yang tidak punya satu pun baris rekap pada bulan itu.
   *
   * Dilaporkan terpisah, bukan ditampilkan sebagai baris nol. Nol yang berasal
   * dari "tidak ada datanya" dan nol yang berasal dari "memang tidak hadir"
   * adalah dua hal yang sangat berbeda, dan menampilkannya sama akan membuat
   * yang pertama terbaca sebagai yang kedua.
   */
  tanpaData: Array<{ employeeId: string; employeeNumber: string; fullName: string }>;
}

export async function buildMonthlyAttendance(
  tx: TenantClient,
  tenantId: string,
  periodYear: number,
  periodMonth: number,
  actor?: { actorUserId: string; correlationId?: string | null | undefined },
): Promise<MonthlyAttendanceReport> {
  const from = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const to = new Date(Date.UTC(periodYear, periodMonth, 0));
  const hariKalender = to.getUTCDate();

  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    orderBy: { employeeNumber: 'asc' },
    select: { id: true, employeeNumber: true, fullName: true },
  });

  // Agregasi dilakukan di BASIS DATA, bukan dengan menarik 3.000 baris ke
  // memori proses lalu menjumlahkannya. Untuk 100 karyawan sebulan selisihnya
  // belum terasa; untuk 1.000 karyawan setahun ia menjadi selisih antara
  // laporan yang terbuka dan permintaan yang kehabisan waktu.
  const agregat = await tx.$queryRaw<
    Array<{
      employee_id: string;
      status: string;
      jumlah: bigint;
      menit_terlambat: bigint;
      menit_lembur: bigint;
      menit_kerja: bigint;
    }>
  >`
    SELECT employee_id, status,
           count(*) AS jumlah,
           coalesce(sum(late_minutes), 0) AS menit_terlambat,
           coalesce(sum(overtime_minutes), 0) AS menit_lembur,
           coalesce(sum(work_minutes), 0) AS menit_kerja
    FROM attendance.attendance_days
    WHERE tenant_id = ${tenantId}::uuid
      AND work_date BETWEEN ${from} AND ${to}
    GROUP BY employee_id, status
  `;

  const perEmployee = new Map<string, MonthlyAttendanceRow>();
  for (const employee of employees) {
    perEmployee.set(employee.id, {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      fullName: employee.fullName,
      hadir: 0,
      terlambat: 0,
      alfa: 0,
      cuti: 0,
      libur: 0,
      liburMingguan: 0,
      hariTercatat: 0,
      menitTerlambat: 0,
      menitLembur: 0,
      jamKerja: 0,
    });
  }

  for (const baris of agregat) {
    const row = perEmployee.get(baris.employee_id);
    // Baris milik karyawan yang sudah tidak aktif dilewati, bukan menjatuhkan
    // laporan. Karyawan yang resign pertengahan bulan tetap punya rekap, dan
    // laporan bulan berjalan memang tentang yang masih bekerja.
    if (!row) continue;

    const jumlah = Number(baris.jumlah);
    row.hariTercatat += jumlah;
    row.menitTerlambat += Number(baris.menit_terlambat);
    row.menitLembur += Number(baris.menit_lembur);
    row.jamKerja += Number(baris.menit_kerja) / 60;

    switch (baris.status) {
      case 'PRESENT':
        row.hadir += jumlah;
        break;
      case 'LATE':
        // Terlambat TETAP hadir. Menghitungnya terpisah dari hadir akan membuat
        // jumlah "hadir + terlambat + alfa" tidak sama dengan hari kerja, dan
        // yang membacanya akan mengira ada hari yang hilang.
        row.hadir += jumlah;
        row.terlambat += jumlah;
        break;
      case 'ABSENT':
        row.alfa += jumlah;
        break;
      case 'LEAVE':
        row.cuti += jumlah;
        break;
      case 'HOLIDAY':
        row.libur += jumlah;
        break;
      case 'DAY_OFF':
        row.liburMingguan += jumlah;
        break;
    }
  }

  const rows = [...perEmployee.values()].map((row) => ({
    ...row,
    jamKerja: Math.round(row.jamKerja * 10) / 10,
  }));

  const tanpaData = rows
    .filter((row) => row.hariTercatat === 0)
    .map((row) => ({
      employeeId: row.employeeId,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
    }));

  const totals = rows.reduce(
    (sum, row) => ({
      karyawan: sum.karyawan + 1,
      hadir: sum.hadir + row.hadir,
      terlambat: sum.terlambat + row.terlambat,
      alfa: sum.alfa + row.alfa,
      cuti: sum.cuti + row.cuti,
      menitTerlambat: sum.menitTerlambat + row.menitTerlambat,
      menitLembur: sum.menitLembur + row.menitLembur,
    }),
    { karyawan: 0, hadir: 0, terlambat: 0, alfa: 0, cuti: 0, menitTerlambat: 0, menitLembur: 0 },
  );

  if (actor) {
    // Laporan ini memuat data kehadiran seluruh karyawan. Membacanya adalah
    // pemindahan data pribadi keluar dari layar, dan jejaknya menjawab "dari
    // mana berkas ini berasal" ketika ia ditemukan di tempat yang tidak
    // seharusnya.
    await writeAudit(tx, tenantId, {
      action: 'report.attendance_monthly.read',
      entityType: 'report',
      actorUserId: actor.actorUserId,
      correlationId: actor.correlationId ?? undefined,
      after: { periodYear, periodMonth, karyawan: totals.karyawan, tanpaData: tanpaData.length },
    });
  }

  return { periodYear, periodMonth, hariKalender, rows, totals, tanpaData };
}

export const MONTHLY_ATTENDANCE_HEADERS = [
  'Nomor Karyawan',
  'Nama',
  'Hadir',
  'Terlambat',
  'Alfa',
  'Cuti',
  'Libur Nasional',
  'Libur Mingguan',
  'Hari Tercatat',
  'Menit Terlambat',
  'Menit Lembur',
  'Jam Kerja',
] as const;

/** Bentuk baris untuk ekspor .xlsx. */
export function monthlyAttendanceRows(report: MonthlyAttendanceReport): string[][] {
  return [
    [...MONTHLY_ATTENDANCE_HEADERS],
    ...report.rows.map((row) => [
      row.employeeNumber,
      row.fullName,
      String(row.hadir),
      String(row.terlambat),
      String(row.alfa),
      String(row.cuti),
      String(row.libur),
      String(row.liburMingguan),
      String(row.hariTercatat),
      String(row.menitTerlambat),
      String(row.menitLembur),
      String(row.jamKerja),
    ]),
  ];
}
