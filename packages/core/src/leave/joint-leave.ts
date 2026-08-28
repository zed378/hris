import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { LeaveError, ensureBalance, writeLedger } from './balance.ts';

/**
 * Cuti bersama: pemotongan jatah cuti tahunan (dokumen 03 §4.2).
 *
 * `holidays.is_joint_leave` ada sejak modul presensi dibangun, dengan komentar
 * yang menyatakan maksudnya persis: *"Cuti bersama memotong hak cuti tahunan;
 * libur nasional tidak."* Tidak ada satu pun jalur kode yang pernah membacanya.
 *
 * Akibatnya berpihak pada karyawan, dan karena itu tidak akan pernah
 * dilaporkan: perusahaan dengan empat hari cuti bersama memberikan **empat hari
 * libur berbayar tambahan per karyawan per tahun** di luar jatah 12 hari. Untuk
 * seratus karyawan itu empat ratus hari kerja yang hilang dari perhitungan
 * siapa pun.
 *
 * Dasarnya SKB 3 Menteri, yang setiap tahun menetapkan cuti bersama sebagai
 * **pengurang** jatah cuti tahunan — berbeda dari libur nasional, yang tidak.
 *
 * ## Yang harus benar, dan mengapa
 *
 * **Idempoten lewat buku besar, bukan lewat penanda.** Setiap pemotongan
 * meninggalkan baris berbuku besar dengan `referenceType: 'holiday'` dan
 * `referenceId` tanggal liburnya. Menjalankan ulang membaca baris itu dan
 * melewatinya. Penanda terpisah — kolom `deducted_at` pada tabel libur — akan
 * benar hanya sampai seseorang menambahkan karyawan baru setelah pemotongan
 * berjalan.
 *
 * **Tidak pernah membuat saldo minus.** Karyawan yang jatahnya sudah habis
 * tetap ikut libur — kantornya tutup — dan yang dapat dipotong hanyalah sisa
 * yang ada. Kekurangannya dilaporkan, bukan dipaksakan: `chk_no_negative_balance`
 * akan menolaknya, dan penolakan itu akan muncul sebagai kegagalan pada
 * karyawan berikutnya yang mengajukan cuti, bukan pada tindakan yang
 * menyebabkannya.
 */

export interface JointLeaveResult {
  /** Tanggal cuti bersama yang diproses. */
  holidays: number;
  /** Karyawan yang saldonya berkurang. */
  employees: number;
  /** Total hari yang terpotong. */
  days: number;
  /**
   * Karyawan yang saldonya tidak cukup, beserta kekurangannya.
   *
   * Dilaporkan, bukan didiamkan. Kekurangan berarti seseorang libur tanpa jatah
   * — keadaan yang perlu diputuskan HR (tidak dibayar, dipinjamkan dari tahun
   * depan, atau dibiarkan), dan keputusan itu tidak dapat diambil bila tidak
   * ada yang tahu.
   */
  shortfalls: Array<{ employeeId: string; days: number }>;
}

/**
 * Memotong jatah cuti tahunan untuk seluruh cuti bersama pada satu tahun.
 *
 * Jenis cuti yang dipotong adalah satu-satunya yang `deductFromBalance` dan
 * ber-akrual berbasis kuota. Bila tenant punya lebih dari satu, yang dipilih
 * adalah yang jatah bawaannya terbesar — jatah tahunan pokok, bukan cuti
 * tambahan yang kebetulan juga memotong saldo.
 */
export async function applyJointLeave(
  tx: TenantClient,
  tenantId: string,
  periodYear: number,
  actorUserId?: string,
): Promise<JointLeaveResult> {
  const holidays = await tx.holiday.findMany({
    where: {
      tenantId,
      isJointLeave: true,
      date: {
        gte: new Date(Date.UTC(periodYear, 0, 1)),
        lte: new Date(Date.UTC(periodYear, 11, 31)),
      },
    },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, name: true },
  });

  const result: JointLeaveResult = {
    holidays: holidays.length,
    employees: 0,
    days: 0,
    shortfalls: [],
  };
  if (holidays.length === 0) return result;

  const leaveType = await tx.leaveType.findFirst({
    where: {
      tenantId,
      isActive: true,
      deductFromBalance: true,
      accrualMethod: { in: ['ANNUAL_GRANT', 'MONTHLY_ACCRUAL', 'ANNIVERSARY'] },
    },
    orderBy: { defaultQuotaDays: 'desc' },
    select: { id: true, name: true },
  });
  if (!leaveType) {
    throw new LeaveError(
      'Tidak ada jenis cuti berbasis kuota yang dapat dipotong cuti bersama',
      'not_found',
    );
  }

  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    select: { id: true },
    orderBy: { employeeNumber: 'asc' },
  });

  const shortfallByEmployee = new Map<string, number>();
  const touched = new Set<string>();

  for (const holiday of holidays) {
    // Baris buku besar yang sudah ada untuk tanggal ini. Inilah kunci
    // idempotensinya — dibaca sekali per tanggal, bukan sekali per karyawan.
    const already = await tx.$queryRaw<Array<{ employee_id: string }>>`
      SELECT b.employee_id
      FROM "leave".balance_ledger l
      JOIN "leave".leave_balances b ON b.id = l.balance_id
      WHERE l.tenant_id = ${tenantId}::uuid
        AND l.reference_type = 'holiday'
        AND l.reference_id = ${holiday.id}::uuid
    `;
    const done = new Set(already.map((row) => row.employee_id));

    for (const employee of employees) {
      if (done.has(employee.id)) continue;

      const balance = await ensureBalance(
        tx,
        tenantId,
        employee.id,
        leaveType.id,
        periodYear,
        actorUserId,
      );

      // Sisa yang ada, paling banyak satu hari. Karyawan yang jatahnya habis
      // tetap ikut libur; yang dapat dipotong hanyalah yang tersedia.
      const deductible = Math.min(1, Math.max(0, balance.availableDays));

      if (deductible < 1) {
        shortfallByEmployee.set(
          employee.id,
          (shortfallByEmployee.get(employee.id) ?? 0) + (1 - deductible),
        );
      }
      if (deductible <= 0) continue;

      await tx.leaveBalance.update({
        where: { id: balance.id },
        data: {
          usedDays: { increment: new Prisma.Decimal(deductible) },
          version: { increment: 1 },
        },
      });

      await writeLedger(tx, tenantId, {
        balanceId: balance.id,
        entryType: 'CONSUME',
        days: -deductible,
        referenceType: 'holiday',
        referenceId: holiday.id,
        note: `Cuti bersama ${holiday.date.toISOString().slice(0, 10)} — ${holiday.name}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      touched.add(employee.id);
      result.days += deductible;
    }
  }

  result.employees = touched.size;
  result.shortfalls = [...shortfallByEmployee].map(([employeeId, days]) => ({
    employeeId,
    days,
  }));

  if (result.days > 0 || result.shortfalls.length > 0) {
    await writeAudit(tx, tenantId, {
      action: 'leave.joint_leave.applied',
      entityType: 'leave_balance',
      ...(actorUserId ? { actorUserId } : {}),
      after: {
        periodYear,
        leaveType: leaveType.name,
        holidays: result.holidays,
        employees: result.employees,
        days: result.days,
        shortfalls: result.shortfalls.length,
      },
    });
  }

  return result;
}

/**
 * Mengembalikan jatah yang dipotong sebuah tanggal cuti bersama.
 *
 * Dipanggil ketika tanggalnya dihapus, atau ketika penandanya diubah menjadi
 * libur nasional biasa. Tanpa ini, koreksi HR hanya berlaku ke satu arah:
 * salah menandai satu tanggal memotong jatah seratus karyawan, dan
 * membatalkannya tidak mengembalikan apa pun. Yang hilang bukan angka di layar
 * — ia hari libur yang tidak lagi dapat diambil seseorang.
 *
 * Pemerintah memang merevisi tanggal cuti bersama di tengah tahun, jadi ini
 * bukan kasus tepi yang dikarang.
 */
export async function revertJointLeave(
  tx: TenantClient,
  tenantId: string,
  holidayId: string,
  actorUserId?: string,
): Promise<{ employees: number; days: number }> {
  const entries = await tx.$queryRaw<
    Array<{ ledger_id: string; balance_id: string; days: Prisma.Decimal }>
  >`
    SELECT l.id AS ledger_id, l.balance_id, l.days
    FROM "leave".balance_ledger l
    WHERE l.tenant_id = ${tenantId}::uuid
      AND l.reference_type = 'holiday'
      AND l.reference_id = ${holidayId}::uuid
      AND l.entry_type = 'CONSUME'
  `;

  let days = 0;

  for (const entry of entries) {
    // `days` pada baris CONSUME bernilai negatif; yang dikembalikan adalah
    // besarannya.
    const amount = entry.days.abs();

    await tx.leaveBalance.update({
      where: { id: entry.balance_id },
      data: { usedDays: { decrement: amount }, version: { increment: 1 } },
    });

    // Baris CONSUME aslinya TIDAK dihapus, dan pengembaliannya ditulis sebagai
    // baris baru. Buku besar yang barisnya dapat hilang bukan buku besar — dan
    // pertanyaan "mengapa jatah saya sempat berkurang lalu kembali" harus punya
    // jawaban yang dapat ditunjukkan.
    await writeLedger(tx, tenantId, {
      balanceId: entry.balance_id,
      entryType: 'ADJUST',
      days: Number(amount),
      referenceType: 'holiday_reverted',
      referenceId: holidayId,
      note: 'Pengembalian potongan cuti bersama — tanggalnya dihapus atau tidak lagi ditandai cuti bersama',
      ...(actorUserId ? { actorUserId } : {}),
    });

    days += Number(amount);
  }

  if (entries.length > 0) {
    await writeAudit(tx, tenantId, {
      action: 'leave.joint_leave.reverted',
      entityType: 'leave_balance',
      entityId: holidayId,
      ...(actorUserId ? { actorUserId } : {}),
      after: { employees: entries.length, days },
    });
  }

  return { employees: entries.length, days };
}
