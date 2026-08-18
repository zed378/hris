import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import type { ActorContext } from './employees.ts';

/**
 * Kontrak kerja dan pengingat berakhirnya (dokumen `08`, A5).
 *
 * Modul ini ditarik maju ke Fase 2 karena rasio nilai per biayanya tertinggi di
 * seluruh katalog, dan alasannya bukan teknis melainkan hukum:
 *
 * **PKWT yang lewat tanpa diperpanjang berubah menjadi PKWTT demi hukum.**
 * Perubahan itu tidak dapat dibatalkan, dan konsekuensinya — pesangon, status
 * tetap, kewajiban yang mengikat selamanya — melebihi biaya langganan setahun
 * untuk satu kontrak saja.
 *
 * Yang membuat modul ini murah: datanya sudah ada. Yang membuatnya bernilai:
 * tidak ada seorang pun yang mengingat tanggal berakhir tiga puluh kontrak.
 */

export const REMINDER_THRESHOLDS = [
  { key: 'D90', days: 90, label: '90 hari lagi' },
  { key: 'D30', days: 30, label: '30 hari lagi' },
  { key: 'D7', days: 7, label: '7 hari lagi' },
] as const;

export type ReminderThreshold = 'D90' | 'D30' | 'D7' | 'EXPIRED';

export class ContractError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
    this.name = 'ContractError';
  }
}

export interface ContractInput {
  employeeId: string;
  contractNumber: string;
  type: 'PKWTT' | 'PKWT' | 'MAGANG' | 'HARIAN' | 'BORONGAN';
  startDate: Date;
  endDate?: Date | null | undefined;
  notes?: string | null | undefined;
}

export async function createContract(
  tx: TenantClient,
  tenantId: string,
  input: ContractInput,
  ctx: ActorContext,
): Promise<{ id: string }> {
  // Aturan yang sama juga ditegakkan CHECK di basis data. Diperiksa di sini
  // supaya pesannya dapat dibaca manusia; diperiksa di sana supaya jalur lain —
  // impor Excel, skrip pemeliharaan — tidak dapat melewatinya.
  if (input.type === 'PKWTT' && input.endDate) {
    throw new ContractError(
      'PKWTT adalah kontrak tetap dan tidak memiliki tanggal berakhir.',
      'invalid',
    );
  }
  if (input.type !== 'PKWTT' && !input.endDate) {
    throw new ContractError(
      `${input.type} wajib memiliki tanggal berakhir. Kontrak berjangka tanpa tanggal berakhir ` +
        'dianggap PKWTT demi hukum.',
      'invalid',
    );
  }

  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, tenantId },
    select: { id: true },
  });
  if (!employee) throw new ContractError('Karyawan tidak ditemukan', 'not_found');

  const contract = await tx.employeeContract.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      contractNumber: input.contractNumber.trim(),
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      notes: input.notes?.trim() || null,
    },
    select: { id: true },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.contract.created',
    entityType: 'employee_contract',
    entityId: contract.id,
    actorUserId: ctx.actorUserId,
    after: {
      contractNumber: input.contractNumber,
      type: input.type,
      endDate: input.endDate?.toISOString().slice(0, 10) ?? null,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return contract;
}

export interface ExpiringContract {
  id: string;
  contractNumber: string;
  type: string;
  endDate: string;
  daysLeft: number;
  employee: { id: string; employeeNumber: string; fullName: string };
}

/**
 * Kontrak yang akan berakhir dalam `withinDays` hari, termasuk yang sudah lewat.
 *
 * Yang sudah lewat sengaja ikut ditampilkan, dengan `daysLeft` negatif. Kontrak
 * yang terlanjur lewat adalah justru yang paling mendesak — ia sudah menjadi
 * masalah hukum, bukan lagi pengingat.
 */
export async function listExpiringContracts(
  tx: TenantClient,
  tenantId: string,
  options: { withinDays?: number; includeExpired?: boolean } = {},
): Promise<ExpiringContract[]> {
  const withinDays = options.withinDays ?? 90;
  const today = startOfDay(new Date());
  const horizon = new Date(today.getTime() + withinDays * 86_400_000);
  const from = options.includeExpired === false ? today : new Date(0);

  const rows = await tx.employeeContract.findMany({
    where: {
      tenantId,
      endDate: { not: null, lte: horizon, gte: from },
      // Karyawan yang sudah keluar tidak perlu diingatkan kontraknya.
      employee: { status: { in: ['ACTIVE', 'PROBATION'] } },
    },
    orderBy: { endDate: 'asc' },
    select: {
      id: true,
      contractNumber: true,
      type: true,
      endDate: true,
      employee: { select: { id: true, employeeNumber: true, fullName: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    contractNumber: row.contractNumber,
    type: row.type,
    endDate: row.endDate!.toISOString().slice(0, 10),
    daysLeft: Math.round((startOfDay(row.endDate!).getTime() - today.getTime()) / 86_400_000),
    employee: row.employee,
  }));
}

export interface ReminderScanResult {
  scanned: number;
  reminded: number;
}

/**
 * Memindai kontrak dan menerbitkan pengingat yang belum pernah dikirim.
 *
 * Dijalankan job harian. Idempotensinya bertumpu sepenuhnya pada constraint
 * `@@unique([contractId, threshold])`: pemindaian memakai rentang tanggal, bukan
 * tanggal persis, sehingga kontrak yang berakhir 90 hari lagi akan tetap masuk
 * pindaian besok dan lusa.
 *
 * Rentang, bukan tanggal persis, adalah pilihan sadar. Pemindaian yang mencari
 * "tepat 90 hari lagi" akan melewatkan kontrak sepenuhnya bila job gagal berjalan
 * satu hari — dan pengingat yang hilang karena satu hari mati adalah kegagalan
 * yang tidak akan pernah disadari sampai kontraknya lewat.
 */
export async function scanContractReminders(
  tx: TenantClient,
  tenantId: string,
): Promise<ReminderScanResult> {
  const today = startOfDay(new Date());
  let reminded = 0;

  const contracts = await tx.employeeContract.findMany({
    where: {
      tenantId,
      endDate: { not: null, gte: new Date(today.getTime() - 30 * 86_400_000) },
      employee: { status: { in: ['ACTIVE', 'PROBATION'] } },
    },
    select: {
      id: true,
      contractNumber: true,
      type: true,
      endDate: true,
      employee: { select: { id: true, employeeNumber: true, fullName: true } },
      reminders: { select: { threshold: true } },
    },
  });

  for (const contract of contracts) {
    if (contract.type === 'PKWTT') continue;

    const daysLeft = Math.round(
      (startOfDay(contract.endDate!).getTime() - today.getTime()) / 86_400_000,
    );
    const sent = new Set(contract.reminders.map((r) => r.threshold));

    // Ambang tertinggi yang sudah terlewati, bukan semuanya. Kontrak yang baru
    // dimasukkan HR ketika sisa 20 hari tidak perlu menerima tiga pengingat
    // sekaligus — yang relevan hanya yang paling mendesak.
    const due: ReminderThreshold | null =
      daysLeft < 0 ? 'EXPIRED'
      : daysLeft <= 7 ? 'D7'
      : daysLeft <= 30 ? 'D30'
      : daysLeft <= 90 ? 'D90'
      : null;

    if (!due || sent.has(due)) continue;

    try {
      await tx.contractReminder.create({
        data: { tenantId, contractId: contract.id, threshold: due },
      });
    } catch {
      // Constraint unique menolak duplikat. Dua job yang berjalan bersamaan —
      // hal yang terjadi saat deploy bertepatan dengan jadwal — akan membuat
      // salah satunya gagal di sini, dan itu perilaku yang benar.
      continue;
    }

    await publishEvent(tx, tenantId, {
      topic: 'employee.contract.expiring',
      payload: {
        tenantId,
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        type: contract.type,
        endDate: contract.endDate!.toISOString().slice(0, 10),
        daysLeft,
        threshold: due,
        employeeId: contract.employee.id,
        employeeNumber: contract.employee.employeeNumber,
        employeeName: contract.employee.fullName,
      },
    });

    reminded += 1;
  }

  return { scanned: contracts.length, reminded };
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
