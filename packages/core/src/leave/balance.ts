import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { accruesOverTime, entitlementAsOf, type AccrualMethod } from './accrual.ts';

/**
 * Saldo cuti dan mutasinya (dokumen 02 §8, dokumen 03 §4.1).
 *
 * Seluruh berkas ini berputar pada satu kalimat pada DoD Fase 4:
 *
 *   "50 persetujuan simultan pada saldo 2 hari → tepat 1 berhasil"
 *
 * Yang menjamin itu adalah tiga lapis yang saling menopang:
 *
 *   1. `SELECT … FOR UPDATE` pada baris saldo — transaksi kedua MENUNGGU di
 *      sini, tidak membaca nilai basi lalu memutuskan atas dasar itu.
 *   2. Validasi yang membaca nilai SETELAH lock diperoleh.
 *   3. `chk_no_negative_balance` di basis data — jaring pengaman terakhir.
 *
 * Lapis ketiga tetap dipasang meski dua lapis pertama sudah benar, dan itu
 * bukan kehati-hatian berlebih: ia yang bertahan ketika seseorang menambahkan
 * jalur tulis baru enam bulan dari sekarang dan lupa mengambil lock-nya.
 *
 * Yang TIDAK dipakai: pengecekan optimistis berbasis `version`. Untuk saldo,
 * kalah balapan berarti pengguna diminta mencoba lagi — dan pada persetujuan
 * cuti massal di akhir bulan, "coba lagi" berarti manajer menekan tombol yang
 * sama lima kali tanpa tahu mengapa.
 */

export class LeaveError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'not_found'
      | 'insufficient_balance'
      | 'overlap'
      | 'invalid_state'
      | 'not_entitled'
      | 'forbidden',
  ) {
    super(message);
    this.name = 'LeaveError';
  }
}

export type LedgerEntryType =
  | 'GRANT'
  | 'ACCRUAL'
  | 'HOLD'
  | 'RELEASE'
  | 'CONSUME'
  | 'EXPIRE'
  | 'ADJUST';

export interface BalanceView {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  periodYear: number;
  entitledDays: number;
  carriedOverDays: number;
  adjustmentDays: number;
  usedDays: number;
  pendingDays: number;
  expiredDays: number;
  /** Dibaca dari kolom GENERATED, tidak pernah dihitung ulang di sini. */
  availableDays: number;
}

interface BalanceRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  code: string;
  name: string;
  period_year: number;
  entitled_days: Prisma.Decimal;
  carried_over_days: Prisma.Decimal;
  adjustment_days: Prisma.Decimal;
  used_days: Prisma.Decimal;
  pending_days: Prisma.Decimal;
  expired_days: Prisma.Decimal;
  available_days: Prisma.Decimal;
}

function toView(row: BalanceRow): BalanceView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveTypeCode: row.code,
    leaveTypeName: row.name,
    periodYear: row.period_year,
    entitledDays: Number(row.entitled_days),
    carriedOverDays: Number(row.carried_over_days),
    adjustmentDays: Number(row.adjustment_days),
    usedDays: Number(row.used_days),
    pendingDays: Number(row.pending_days),
    expiredDays: Number(row.expired_days),
    availableDays: Number(row.available_days),
  };
}

/**
 * Membaca saldo, termasuk kolom `available_days` yang dihitung basis data.
 *
 * Query mentah, bukan Prisma, semata karena kolom GENERATED tidak dapat
 * dideklarasikan di model Prisma. Menghitung ulang rumusnya di TypeScript akan
 * menghasilkan dua sumber kebenaran yang pasti berbeda pada hari seseorang
 * menambahkan jenis mutasi baru.
 */
export async function readBalances(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  periodYear: number,
): Promise<BalanceView[]> {
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT b.id, b.employee_id, b.leave_type_id, t.code, t.name, b.period_year,
           b.entitled_days, b.carried_over_days, b.adjustment_days,
           b.used_days, b.pending_days, b.expired_days, b.available_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.employee_id = ${employeeId}::uuid
      AND b.period_year = ${periodYear}
    ORDER BY t.code
  `;
  return rows.map(toView);
}

/**
 * Mengunci baris saldo dan mengembalikan keadaannya setelah terkunci.
 *
 * `FOR UPDATE` inilah lapis pertama. Transaksi kedua yang meminta baris yang
 * sama akan berhenti di sini sampai transaksi pertama selesai, lalu membaca
 * nilai yang SUDAH memperhitungkan perubahan transaksi pertama.
 *
 * Tanpa ini, dua transaksi sama-sama membaca "tersedia 2 hari", sama-sama
 * menyimpulkan cukup, dan sama-sama menulis — menghasilkan saldo minus yang
 * hanya tertahan oleh constraint, dan tertahan sebagai galat basis data yang
 * tidak dapat dijelaskan kepada penggunanya.
 */
export async function lockBalance(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
): Promise<BalanceView | null> {
  // Dua langkah karena `FOR UPDATE` tidak dapat dipakai bersama JOIN pada
  // sebagian bentuk query; yang perlu dikunci hanya baris saldonya.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "leave".leave_balances
    WHERE tenant_id = ${tenantId}::uuid
      AND employee_id = ${employeeId}::uuid
      AND leave_type_id = ${leaveTypeId}::uuid
      AND period_year = ${periodYear}
    FOR UPDATE
  `;
  if (locked.length === 0) return null;

  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT b.id, b.employee_id, b.leave_type_id, t.code, t.name, b.period_year,
           b.entitled_days, b.carried_over_days, b.adjustment_days,
           b.used_days, b.pending_days, b.expired_days, b.available_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.id = ${locked[0]!.id}::uuid
  `;
  return rows[0] ? toView(rows[0]) : null;
}

export interface LedgerEntry {
  balanceId: string;
  entryType: LedgerEntryType;
  /** Positif menambah saldo tersedia, negatif menguranginya. */
  days: number;
  referenceType?: string | undefined;
  referenceId?: string | undefined;
  note?: string | undefined;
  actorUserId?: string | undefined;
}

/**
 * Menulis satu baris buku besar.
 *
 * Dipanggil pada SETIAP perubahan saldo, tanpa kecuali. Fungsi yang mengubah
 * kolom saldo tanpa memanggil ini adalah bug, meski angkanya benar — karena
 * saldo yang benar tanpa riwayat tidak dapat dipertahankan dalam perselisihan.
 */
export async function writeLedger(
  tx: TenantClient,
  tenantId: string,
  entry: LedgerEntry,
): Promise<void> {
  await tx.balanceLedger.create({
    data: {
      tenantId,
      balanceId: entry.balanceId,
      entryType: entry.entryType,
      days: new Prisma.Decimal(entry.days),
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      note: entry.note ?? null,
      createdBy: entry.actorUserId ?? null,
    },
  });
}

/**
 * Memastikan baris saldo ada untuk kombinasi karyawan-jenis-tahun.
 *
 * Dibuat saat dibutuhkan, bukan lewat job massal di awal tahun. Job massal
 * untuk seluruh karyawan × seluruh jenis cuti menghasilkan ribuan baris yang
 * sebagian besar tidak pernah dipakai, dan tetap saja meleset untuk karyawan
 * yang masuk pada bulan Maret.
 */
export async function ensureBalance(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
  actorUserId?: string,
  /** Tanggal penilaian akrual. Disuntikkan agar dapat diuji. */
  asOf: Date = new Date(),
): Promise<BalanceView> {
  const type = await tx.leaveType.findFirst({
    where: { id: leaveTypeId, tenantId },
    select: { defaultQuotaDays: true, accrualMethod: true },
  });
  if (!type) throw new LeaveError('Jenis cuti tidak ditemukan', 'not_found');

  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { joinDate: true },
  });
  if (!employee) throw new LeaveError('Karyawan tidak ditemukan', 'not_found');

  const method = type.accrualMethod as AccrualMethod;
  const target = entitlementAsOf({
    method,
    quotaDays: type.defaultQuotaDays,
    joinDate: employee.joinDate,
    periodYear,
    asOf,
  });

  const existing = await lockBalance(tx, tenantId, employeeId, leaveTypeId, periodYear);

  // Baris yang sudah ada IKUT DIREKONSILIASI, bukan dikembalikan apa adanya.
  //
  // Tanpa ini, akrual bulanan hanya benar pada hari baris itu dibuat. Karyawan
  // yang barisnya lahir bulan Maret akan selamanya melihat jatah bulan Maret,
  // karena tidak ada satu pun jalur yang menyentuhnya lagi — dan job berkala
  // tidak dapat menutupinya sendirian, sebab job yang belum sempat jalan
  // meninggalkan angka basi tepat pada saat seseorang mengajukan cuti.
  if (existing) return reconcileEntitlement(tx, tenantId, existing, method, target, actorUserId);

  const created = await tx.leaveBalance.create({
    data: { tenantId, employeeId, leaveTypeId, periodYear, entitledDays: target },
    select: { id: true },
  });

  if (!target.isZero()) {
    await writeLedger(tx, tenantId, {
      balanceId: created.id,
      entryType: method === 'ANNUAL_GRANT' ? 'GRANT' : 'ACCRUAL',
      days: Number(target),
      referenceType: 'leave_type',
      referenceId: leaveTypeId,
      note: grantNote(method, periodYear, Number(target)),
      ...(actorUserId ? { actorUserId } : {}),
    });
  }

  const balance = await lockBalance(tx, tenantId, employeeId, leaveTypeId, periodYear);
  if (!balance) throw new LeaveError('Saldo gagal dibuat', 'not_found');
  return balance;
}

function grantNote(method: AccrualMethod, periodYear: number, days: number): string {
  switch (method) {
    case 'MONTHLY_ACCRUAL':
      return `Akrual bulanan ${periodYear} — ${days} hari terkumpul`;
    case 'ANNIVERSARY':
      return `Jatah ulang tahun masa kerja ${periodYear}`;
    default:
      return `Jatah tahunan ${periodYear}`;
  }
}

/**
 * Menaikkan `entitled_days` ke target akrual, bila memang perlu naik.
 *
 * **Tidak pernah menurunkan.** Jatah yang sudah diberikan mungkin sudah dipakai,
 * dan menariknya kembali menghasilkan saldo minus yang ditolak
 * `chk_no_negative_balance` — kegagalan yang muncul pada orang berikutnya yang
 * mengajukan cuti, bukan pada perubahan yang menyebabkannya. Kuota yang turun
 * atau tanggal masuk yang dikoreksi mundur adalah keputusan HR, dan jalurnya
 * `adjustBalance`, yang meminta alasan dan meninggalkan jejak audit.
 */
async function reconcileEntitlement(
  tx: TenantClient,
  tenantId: string,
  balance: BalanceView,
  method: AccrualMethod,
  target: Prisma.Decimal,
  actorUserId?: string,
): Promise<BalanceView> {
  if (!accruesOverTime(method)) return balance;

  const delta = target.minus(balance.entitledDays);
  if (delta.lessThanOrEqualTo(0)) return balance;

  await tx.leaveBalance.update({
    where: { id: balance.id },
    data: {
      entitledDays: { increment: delta },
      version: { increment: 1 },
    },
  });

  await writeLedger(tx, tenantId, {
    balanceId: balance.id,
    entryType: 'ACCRUAL',
    days: Number(delta),
    note:
      method === 'ANNIVERSARY'
        ? `Jatah lahir pada ulang tahun masa kerja — ${Number(target)} hari`
        : `Akrual bulanan — bertambah ${Number(delta)} hari, total ${Number(target)}`,
    ...(actorUserId ? { actorUserId } : {}),
  });

  return { ...balance, entitledDays: Number(target), availableDays: balance.availableDays + Number(delta) };
}

export interface AdjustInput {
  employeeId: string;
  leaveTypeId: string;
  periodYear: number;
  days: number;
  reason: string;
}

/** Penyesuaian manual saldo oleh HR. Selalu diaudit dan selalu berbuku besar. */
export async function adjustBalance(
  tx: TenantClient,
  tenantId: string,
  input: AdjustInput,
  actorUserId: string,
): Promise<BalanceView> {
  const balance = await ensureBalance(
    tx,
    tenantId,
    input.employeeId,
    input.leaveTypeId,
    input.periodYear,
    actorUserId,
  );

  if (balance.availableDays + input.days < 0) {
    throw new LeaveError(
      `Penyesuaian ${input.days} hari akan membuat saldo minus. Tersedia ${balance.availableDays} hari.`,
      'insufficient_balance',
    );
  }

  await tx.leaveBalance.update({
    where: { id: balance.id },
    data: {
      adjustmentDays: { increment: new Prisma.Decimal(input.days) },
      version: { increment: 1 },
    },
  });

  await writeLedger(tx, tenantId, {
    balanceId: balance.id,
    entryType: 'ADJUST',
    days: input.days,
    note: input.reason,
    actorUserId,
  });

  await writeAudit(tx, tenantId, {
    action: 'leave.balance.adjusted',
    entityType: 'leave_balance',
    entityId: balance.id,
    actorUserId,
    before: { availableDays: balance.availableDays },
    after: { days: input.days, reason: input.reason },
  });

  const updated = await lockBalance(
    tx,
    tenantId,
    input.employeeId,
    input.leaveTypeId,
    input.periodYear,
  );
  return updated!;
}

/** Riwayat mutasi satu saldo, terbaru dahulu. */
export async function readLedger(
  tx: TenantClient,
  tenantId: string,
  balanceId: string,
  limit = 100,
): Promise<
  Array<{
    id: string;
    entryType: string;
    days: number;
    note: string | null;
    referenceId: string | null;
    createdAt: string;
  }>
> {
  const rows = await tx.balanceLedger.findMany({
    where: { tenantId, balanceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    // `BigInt` tidak dapat diserialkan ke JSON. Diubah di sini, di batas modul,
    // bukan diserahkan ke setiap pemanggil untuk diingat.
    id: String(row.id),
    entryType: row.entryType,
    days: Number(row.days),
    note: row.note,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface CarryOverResult {
  employees: number;
  carriedOver: number;
  expired: number;
}

/**
 * Menutup tahun: membawa sisa saldo ke tahun berikutnya, sisanya hangus.
 *
 * Dua mutasi, bukan satu. Sisa 10 hari dengan batas carry-over 6 menghasilkan
 * `carried_over_days = 6` pada tahun baru DAN `expired_days = 4` pada tahun
 * lama — bukan sekadar 6 yang muncul entah dari mana.
 *
 * Perbedaannya penting saat karyawan bertanya ke mana perginya empat hari itu.
 * Saldo yang hilang tanpa baris buku besar tidak dapat dijelaskan siapa pun,
 * dan pertanyaan itu selalu datang pada bulan Januari.
 *
 * Idempoten: menjalankannya dua kali tidak menggandakan apa pun, karena
 * `expired_days` yang sudah terisi menandai tahun itu sudah ditutup.
 */
export async function runCarryOver(
  tx: TenantClient,
  tenantId: string,
  fromYear: number,
  actorUserId?: string,
): Promise<CarryOverResult> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      employee_id: string;
      leave_type_id: string;
      available_days: Prisma.Decimal;
      expired_days: Prisma.Decimal;
      max_carry_over_days: Prisma.Decimal;
    }>
  >`
    SELECT b.id, b.employee_id, b.leave_type_id, b.available_days, b.expired_days,
           t.max_carry_over_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.period_year = ${fromYear}
      AND t.deduct_from_balance = true
  `;

  const result: CarryOverResult = { employees: 0, carriedOver: 0, expired: 0 };

  for (const row of rows) {
    // Tahun yang sudah ditutup dilewati. Tanpa penjaga ini, menjalankan job dua
    // kali akan membawa sisa yang sama ke tahun berikutnya untuk kedua kalinya.
    if (!row.expired_days.isZero()) continue;

    const available = Number(row.available_days);
    if (available <= 0) continue;

    const maxCarry = Number(row.max_carry_over_days);
    const carried = Math.min(available, maxCarry);
    const expired = available - carried;

    result.employees += 1;

    if (expired > 0) {
      await tx.leaveBalance.update({
        where: { id: row.id },
        data: {
          expiredDays: { increment: new Prisma.Decimal(expired) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: row.id,
        entryType: 'EXPIRE',
        days: -expired,
        note: `Hangus pada penutupan tahun ${fromYear} (batas bawa ${maxCarry} hari)`,
        ...(actorUserId ? { actorUserId } : {}),
      });
      result.expired += expired;
    }

    if (carried > 0) {
      const next = await ensureBalance(
        tx,
        tenantId,
        row.employee_id,
        row.leave_type_id,
        fromYear + 1,
        actorUserId,
      );

      await tx.leaveBalance.update({
        where: { id: next.id },
        data: {
          carriedOverDays: { increment: new Prisma.Decimal(carried) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: next.id,
        entryType: 'GRANT',
        days: carried,
        note: `Sisa cuti ${fromYear} yang dibawa ke ${fromYear + 1}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      // Sisi tahun lama juga ditandai, supaya jumlah kolomnya tetap konsisten
      // dan tahun itu terhitung sudah ditutup.
      await tx.leaveBalance.update({
        where: { id: row.id },
        data: {
          expiredDays: { increment: new Prisma.Decimal(carried) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: row.id,
        entryType: 'EXPIRE',
        days: -carried,
        note: `Dipindahkan ke tahun ${fromYear + 1}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      result.carriedOver += carried;
    }
  }

  return result;
}

export interface AccrualResult {
  /** Baris saldo yang ditinjau. */
  reviewed: number;
  /** Baris yang jatahnya bertambah. */
  accrued: number;
  /** Total hari yang ditambahkan. */
  days: number;
}

/**
 * Meninjau ulang seluruh saldo tahun berjalan yang jatahnya tumbuh seiring waktu.
 *
 * Dijalankan berkala oleh worker. Yang dilakukannya sama persis dengan yang
 * dilakukan `ensureBalance` saat seseorang mengajukan cuti — bedanya hanya
 * cakupan: job ini menyentuh semua orang, sehingga angka di layar saldo sudah
 * benar sebelum ada yang mengajukan apa pun.
 *
 * Idempoten karena membandingkan TARGET, bukan menambahkan jatah. Menjalankannya
 * dua kali sehari menghasilkan selisih nol pada putaran kedua; job yang mati
 * selama tiga bulan mengejar seluruh ketertinggalannya dalam satu putaran.
 *
 * Hanya menyentuh baris yang SUDAH ADA. Membuat baris untuk setiap karyawan ×
 * setiap jenis cuti akan menghasilkan ribuan baris yang sebagian besar tidak
 * pernah dipakai — dan `ensureBalance` sudah menghitung dengan benar pada baris
 * yang lahir kemudian, berapa pun bulan kelahirannya.
 */
export async function runAccrual(
  tx: TenantClient,
  tenantId: string,
  asOf: Date,
  actorUserId?: string,
): Promise<AccrualResult> {
  const periodYear = asOf.getUTCFullYear();

  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      employee_id: string;
      leave_type_id: string;
      entitled_days: Prisma.Decimal;
      default_quota_days: Prisma.Decimal;
      accrual_method: string;
      join_date: Date;
    }>
  >`
    SELECT b.id, b.employee_id, b.leave_type_id, b.entitled_days,
           t.default_quota_days, t.accrual_method, e.join_date
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    JOIN employee.employees e ON e.id = b.employee_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.period_year = ${periodYear}
      AND t.accrual_method IN ('MONTHLY_ACCRUAL', 'ANNIVERSARY')
      AND t.is_active = true
      -- Karyawan yang sudah keluar berhenti menabung jatah. Tanpa penyaring
      -- ini, orang yang resign bulan Maret tetap memperoleh jatah sampai
      -- Desember, dan angkanya muncul lagi saat perhitungan pesangon.
      AND e.status = 'ACTIVE'
  `;

  const result: AccrualResult = { reviewed: rows.length, accrued: 0, days: 0 };

  for (const row of rows) {
    const target = entitlementAsOf({
      method: row.accrual_method as AccrualMethod,
      quotaDays: row.default_quota_days,
      joinDate: row.join_date,
      periodYear,
      asOf,
    });

    const delta = target.minus(row.entitled_days);
    if (delta.lessThanOrEqualTo(0)) continue;

    await tx.leaveBalance.update({
      where: { id: row.id },
      data: { entitledDays: { increment: delta }, version: { increment: 1 } },
    });
    await writeLedger(tx, tenantId, {
      balanceId: row.id,
      entryType: 'ACCRUAL',
      days: Number(delta),
      note:
        row.accrual_method === 'ANNIVERSARY'
          ? `Jatah lahir pada ulang tahun masa kerja — ${Number(target)} hari`
          : `Akrual bulanan — bertambah ${Number(delta)} hari, total ${Number(target)}`,
      ...(actorUserId ? { actorUserId } : {}),
    });

    result.accrued += 1;
    result.days += Number(delta);
  }

  return result;
}
