import { writeAudit, type TenantClient } from '@hrms/db';
import { EMPLOYEE_COLUMNS } from './import-schema.ts';
import { revealPii } from './pii.ts';
import type { ActorContext } from './employees.ts';

/**
 * Ekspor karyawan ke Excel.
 *
 * Dua sifat yang membentuk seluruh berkas ini.
 *
 * **1. Hasilnya harus dapat diimpor kembali.** Kolomnya persis sama dengan yang
 * dikenali pengurai impor, dalam urutan yang sama. Itu membuat Excel tetap
 * menjadi alat kerja yang sah: ekspor → sunting massal di Excel → impor ulang,
 * tanpa satu pun langkah penyesuaian.
 *
 * PLAN/00 §2.1 menyebut ini syarat kepercayaan, bukan fitur: pelanggan harus
 * merasa datanya tidak tersandera. Produk yang datanya mudah dikeluarkan justru
 * lebih jarang ditinggalkan.
 *
 * **2. Ekspor bukan jalan pintas melewati masking.** Pengguna tanpa
 * `employee.pii.unmask` mengunduh berkas berisi nilai tersamar. Bila tidak
 * demikian, seluruh kerja di `pii.ts` runtuh menjadi hiasan layar — siapa pun
 * yang dapat membuka daftar cukup menekan "Ekspor" untuk mendapatkan NIK
 * lengkap seisi perusahaan.
 */

export interface ExportOptions {
  search?: string | undefined;
  status?: string | undefined;
  departmentId?: string | undefined;
  canUnmask: boolean;
}

/** Batas atas satu berkas ekspor. */
const MAX_EXPORT_ROWS = 20_000;

export interface ExportResult {
  /** Baris siap tulis: baris pertama judul, sisanya data. */
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

export async function buildEmployeeExport(
  tx: TenantClient,
  tenantId: string,
  options: ExportOptions,
  ctx: ActorContext,
): Promise<ExportResult> {
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

  const total = await tx.employee.count({ where });

  const employees = await tx.employee.findMany({
    where,
    take: MAX_EXPORT_ROWS,
    orderBy: [{ employeeNumber: 'asc' }],
    select: {
      employeeNumber: true,
      fullName: true,
      email: true,
      phone: true,
      birthDate: true,
      birthPlace: true,
      gender: true,
      address: true,
      bankName: true,
      joinDate: true,
      nationalIdEncrypted: true,
      nationalIdMasked: true,
      taxIdEncrypted: true,
      taxIdMasked: true,
      bankAccountEncrypted: true,
      bankAccountMasked: true,
    },
  });

  // Judul memakai label tanpa tanda bintang: berkas hasil ekspor adalah berkas
  // data, bukan formulir. Alias pengurai impor mengenali label ini apa adanya,
  // sehingga berkas ini dapat diunggah kembali tanpa disunting.
  const header = EMPLOYEE_COLUMNS.map((column) => column.label);

  const rows = employees.map((employee) => {
    const pii = revealPii(employee, options.canUnmask);

    const value: Record<string, string> = {
      employeeNumber: employee.employeeNumber,
      fullName: employee.fullName,
      nationalId: pii.nationalId ?? '',
      taxId: pii.taxId ?? '',
      email: employee.email ?? '',
      phone: employee.phone ?? '',
      // Tanggal ditulis dd/mm/yyyy — bentuk yang sama yang diterima pengurai
      // impor dan yang dikenali Excel berlokal Indonesia. Menulis ISO akan
      // membuat Excel menampilkannya sebagai teks rata kiri, dan hal pertama
      // yang dilakukan orang adalah "memperbaikinya" menjadi format lain.
      joinDate: formatDate(employee.joinDate),
      birthDate: formatDate(employee.birthDate),
      birthPlace: employee.birthPlace ?? '',
      gender: employee.gender === 'MALE' ? 'L' : employee.gender === 'FEMALE' ? 'P' : '',
      bankName: employee.bankName ?? '',
      bankAccount: pii.bankAccount ?? '',
      address: employee.address ?? '',
    };

    return EMPLOYEE_COLUMNS.map((column) => value[column.field] ?? '');
  });

  // Ekspor dicatat di jejak audit, dan ini bukan formalitas: mengunduh seluruh
  // basis data karyawan adalah persis yang dilakukan seseorang menjelang pindah
  // kerja. Yang dicatat adalah jumlah dan penyaringnya, bukan isinya.
  await writeAudit(tx, tenantId, {
    action: 'employee.exported',
    entityType: 'employee',
    actorUserId: ctx.actorUserId,
    after: {
      rowCount: rows.length,
      unmasked: options.canUnmask,
      filters: {
        search: options.search ?? null,
        status: options.status ?? null,
        departmentId: options.departmentId ?? null,
      },
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return {
    rows: [header, ...rows],
    rowCount: rows.length,
    truncated: total > rows.length,
  };
}

/** dd/mm/yyyy — bentuk yang sama yang diterima pengurai impor. */
function formatDate(date: Date | null): string {
  if (!date) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}
