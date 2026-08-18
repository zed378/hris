import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import {
  blindIndex,
  maskBankAccount,
  maskNationalId,
  maskTaxId,
  preparePii,
  revealPii,
  type PiiFields,
} from './pii.ts';

/**
 * Modul karyawan (PLAN/12 Fase 2).
 *
 * Dua hal yang membentuk seluruh berkas ini:
 *
 * 1. **PII tidak pernah didekripsi tanpa alasan.** Setiap fungsi menerima
 *    `canUnmask` secara eksplisit, bukan membacanya dari konteks global. Parameter
 *    yang harus diisi memaksa pemanggilnya memutuskan; nilai dari konteks akan
 *    diam-diam benar di satu tempat dan diam-diam salah di tempat berikutnya.
 *
 * 2. **Riwayat penempatan tidak pernah ditimpa** (P13). Mutasi menutup periode
 *    berjalan dan membuka baris baru, sehingga "siapa kepala departemen ini bulan
 *    Maret lalu" tetap dapat dijawab tahun depan.
 */

export class EmployeeError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict' | 'stale',
  ) {
    super(message);
    this.name = 'EmployeeError';
  }
}

export interface ActorContext {
  actorUserId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/**
 * Masukan data karyawan.
 *
 * Setiap field opsional menyertakan `| undefined` secara eksplisit karena
 * `exactOptionalPropertyTypes` aktif. Itu membedakan "kolom tidak dikirim"
 * dari "kolom sengaja dikosongkan" — pada data karyawan keduanya berarti hal
 * yang berbeda: yang pertama tidak mengubah apa pun, yang kedua menghapus.
 */
export interface EmployeeInput {
  employeeNumber: string;
  fullName: string;
  nationalId?: string | null | undefined;
  taxId?: string | null | undefined;
  bankAccount?: string | null | undefined;
  bankName?: string | null | undefined;
  bankAccountHolder?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  birthDate?: Date | null | undefined;
  birthPlace?: string | null | undefined;
  gender?: 'MALE' | 'FEMALE' | null | undefined;
  address?: string | null | undefined;
  joinDate: Date;
  status?: 'PROBATION' | 'ACTIVE' | 'RESIGNED' | 'TERMINATED' | undefined;
}

/**
 * Perubahan sebagian atas data karyawan.
 *
 * Bukan `Partial<EmployeeInput>`: dengan `exactOptionalPropertyTypes`, `Partial`
 * hanya menandai properti boleh tidak ada, sedangkan objek hasil parse Zod
 * membawa properti yang ada tetapi bernilai `undefined`. Tipe ini menerima
 * keduanya.
 */
export type EmployeeUpdate = {
  [K in keyof EmployeeInput]?: EmployeeInput[K] | undefined;
};

export interface EmployeeSummary {
  id: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  joinDate: string;
  department: string | null;
  position: string | null;
  version: number;
  pii: PiiFields;
}

const PII_SELECT = {
  nationalIdEncrypted: true,
  nationalIdMasked: true,
  taxIdEncrypted: true,
  taxIdMasked: true,
  bankAccountEncrypted: true,
  bankAccountMasked: true,
} as const;

/**
 * Daftar karyawan.
 *
 * `canUnmask` hampir selalu `false` di sini, dan itu memang jalur yang benar:
 * daftar adalah layar yang paling sering dibuka dan paling jarang membutuhkan
 * nomor identitas lengkap. Dengan kolom tersamar tersimpan, jalur ini tidak
 * menyentuh kunci enkripsi sama sekali.
 */
export async function listEmployees(
  tx: TenantClient,
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    search?: string | undefined;
    status?: string | undefined;
    departmentId?: string | undefined;
    canUnmask?: boolean;
  } = {},
): Promise<{ employees: EmployeeSummary[]; total: number }> {
  const where = {
    tenantId,
    ...(options.status ? { status: options.status as never } : {}),
    ...(options.search
      ? {
          OR: [
            { fullName: { contains: options.search, mode: 'insensitive' as const } },
            { employeeNumber: { contains: options.search, mode: 'insensitive' as const } },
            { email: { contains: options.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(options.departmentId
      ? { employments: { some: { departmentId: options.departmentId, effectiveTo: null } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    tx.employee.findMany({
      where,
      take: Math.min(options.limit ?? 50, 500),
      skip: options.offset ?? 0,
      orderBy: [{ fullName: 'asc' }],
      select: {
        id: true,
        employeeNumber: true,
        fullName: true,
        email: true,
        phone: true,
        status: true,
        joinDate: true,
        version: true,
        ...PII_SELECT,
        // Hanya penempatan yang sedang berjalan. Indeks unik parsial menjamin
        // paling banyak ada satu, sehingga `[0]` di bawah aman.
        employments: {
          where: { effectiveTo: null },
          select: {
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
          take: 1,
        },
      },
    }),
    tx.employee.count({ where }),
  ]);

  return {
    total,
    employees: rows.map((row) => ({
      id: row.id,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
      email: row.email,
      phone: row.phone,
      status: row.status,
      joinDate: row.joinDate.toISOString().slice(0, 10),
      department: row.employments[0]?.department.name ?? null,
      position: row.employments[0]?.position.name ?? null,
      version: row.version,
      pii: revealPii(row, options.canUnmask ?? false),
    })),
  };
}

export async function getEmployee(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  canUnmask: boolean,
): Promise<EmployeeSummary & { bankName: string | null; address: string | null }> {
  const row = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: {
      id: true,
      employeeNumber: true,
      fullName: true,
      email: true,
      phone: true,
      status: true,
      joinDate: true,
      version: true,
      bankName: true,
      address: true,
      ...PII_SELECT,
      employments: {
        where: { effectiveTo: null },
        select: {
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
        take: 1,
      },
    },
  });

  if (!row) throw new EmployeeError('Karyawan tidak ditemukan', 'not_found');

  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    joinDate: row.joinDate.toISOString().slice(0, 10),
    department: row.employments[0]?.department.name ?? null,
    position: row.employments[0]?.position.name ?? null,
    version: row.version,
    bankName: row.bankName,
    address: row.address,
    pii: revealPii(row, canUnmask),
  };
}

/** Membentuk kolom tersimpan dari masukan mentah. */
function piiColumns(input: EmployeeInput) {
  const nationalId = preparePii(input.nationalId, maskNationalId);
  const taxId = preparePii(input.taxId, maskTaxId);
  const bankAccount = preparePii(input.bankAccount, maskBankAccount);

  return {
    nationalIdEncrypted: nationalId.encrypted,
    nationalIdIndex: nationalId.index,
    nationalIdMasked: nationalId.masked,
    taxIdEncrypted: taxId.encrypted,
    taxIdIndex: taxId.index,
    taxIdMasked: taxId.masked,
    bankAccountEncrypted: bankAccount.encrypted,
    bankAccountMasked: bankAccount.masked,
  };
}

export async function createEmployee(
  tx: TenantClient,
  tenantId: string,
  input: EmployeeInput,
  ctx: ActorContext,
): Promise<{ id: string }> {
  const employee = await tx.employee.create({
    data: {
      tenantId,
      employeeNumber: input.employeeNumber.trim(),
      fullName: input.fullName.trim(),
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      birthDate: input.birthDate ?? null,
      birthPlace: input.birthPlace?.trim() || null,
      gender: input.gender ?? null,
      address: input.address?.trim() || null,
      bankName: input.bankName?.trim() || null,
      bankAccountHolder: input.bankAccountHolder?.trim() || null,
      joinDate: input.joinDate,
      status: input.status ?? 'ACTIVE',
      ...piiColumns(input),
    },
    select: { id: true },
  });

  // Jejak audit sengaja TIDAK memuat nilai PII, bahkan yang tersamar. Tabel audit
  // disimpan tujuh tahun dan dibaca oleh peran yang lebih luas daripada yang boleh
  // melihat data karyawan; menyalin PII ke sana membatalkan seluruh kerja di pii.ts.
  await writeAudit(tx, tenantId, {
    action: 'employee.created',
    entityType: 'employee',
    entityId: employee.id,
    actorUserId: ctx.actorUserId,
    after: { employeeNumber: input.employeeNumber, fullName: input.fullName },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  await publishEvent(tx, tenantId, {
    topic: 'employee.created',
    payload: { tenantId, employeeId: employee.id, employeeNumber: input.employeeNumber },
    correlationId: ctx.correlationId,
  });

  return employee;
}

/**
 * Memperbarui karyawan dengan penguncian optimistis.
 *
 * `expectedVersion` datang dari data yang dibaca klien. Bila tidak cocok, berarti
 * ada yang menyimpan lebih dulu — dan menimpanya berarti perubahan orang itu
 * hilang tanpa seorang pun tahu (dok. 03 §4.6). Grid ala Excel membuat ini bukan
 * kasus langka: dua HR menyunting daftar yang sama adalah hari kerja biasa.
 */
export async function updateEmployee(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  expectedVersion: number,
  input: EmployeeUpdate,
  ctx: ActorContext,
): Promise<{ version: number }> {
  const before = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { version: true, employeeNumber: true, fullName: true, status: true },
  });
  if (!before) throw new EmployeeError('Karyawan tidak ditemukan', 'not_found');

  const piiTouched =
    input.nationalId !== undefined ||
    input.taxId !== undefined ||
    input.bankAccount !== undefined;

  const updated = await tx.employee.updateMany({
    where: { id: employeeId, tenantId, version: expectedVersion },
    data: {
      ...(input.employeeNumber !== undefined ? { employeeNumber: input.employeeNumber.trim() } : {}),
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
      ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
      ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
      ...(input.bankName !== undefined ? { bankName: input.bankName?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(piiTouched ? piiColumns(input as EmployeeInput) : {}),
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw new EmployeeError(
      'Data ini sudah diubah orang lain. Muat ulang sebelum menyimpan.',
      'stale',
    );
  }

  await writeAudit(tx, tenantId, {
    action: 'employee.updated',
    entityType: 'employee',
    entityId: employeeId,
    actorUserId: ctx.actorUserId,
    before: { fullName: before.fullName, status: before.status },
    // Hanya nama kolom PII yang dicatat, bukan nilainya — cukup untuk menjawab
    // "siapa mengubah rekening siapa dan kapan" tanpa menyimpan nomornya.
    after: {
      fullName: input.fullName ?? before.fullName,
      status: input.status ?? before.status,
      ...(piiTouched ? { piiChanged: true } : {}),
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return { version: expectedVersion + 1 };
}

/**
 * Mencari karyawan berdasarkan NIK tanpa mendekripsi apa pun.
 *
 * Inilah gunanya indeks buta: pencarian dilakukan atas HMAC, dan basis data tidak
 * pernah melihat NIK dalam bentuk yang dapat dibaca.
 */
export async function findByNationalId(
  tx: TenantClient,
  tenantId: string,
  nationalId: string,
): Promise<{ id: string; employeeNumber: string; fullName: string } | null> {
  return tx.employee.findFirst({
    where: { tenantId, nationalIdIndex: blindIndex(nationalId) },
    select: { id: true, employeeNumber: true, fullName: true },
  });
}
