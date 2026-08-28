import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { checkFormula } from './formula.ts';

/**
 * Komponen gaji dan struktur gaji per karyawan (PLAN/12 F5).
 *
 * Dua penjagaan yang dilakukan di sini, dan keduanya mencegah kegagalan yang
 * baru terlihat pada tanggal 25 ketika seribu slip harus keluar besok:
 *
 *   1. **Formula diperiksa saat DISIMPAN**, bukan saat run berjalan. Formula
 *      yang merujuk variabel tidak dikenal ditolak di layar konfigurasi.
 *   2. **Siklus ketergantungan ditolak.** Komponen A yang memakai B yang
 *      memakai A akan membuat perhitungan berputar tanpa henti — dan pada run
 *      seribu karyawan, "berputar tanpa henti" berarti seluruh proses payroll
 *      berhenti tanpa satu pun slip terbit.
 */

export class ComponentError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'invalid_formula' | 'cycle' | 'conflict',
  ) {
    super(message);
    this.name = 'ComponentError';
  }
}

/**
 * Variabel yang tersedia bagi formula.
 *
 * Daftar ini adalah kontrak antara layar konfigurasi dan mesin perhitungan.
 * Menambahkan variabel di sini tanpa menyediakannya di `buildScope` akan
 * meloloskan formula yang lalu gagal saat run — yaitu tepat kegagalan yang
 * pemeriksaan formula ini ada untuk mencegahnya.
 */
export const BASE_VARIABLES = [
  /** Hari kerja terjadwal pada periode ini. */
  'HARI_KERJA',
  /** Hari hadir menurut rekap presensi. */
  'HARI_HADIR',
  /** Hari tidak hadir tanpa keterangan. */
  'HARI_ALFA',
  /** Hari cuti tanpa gaji. */
  'HARI_CUTI_TANPA_GAJI',
  /** Menit keterlambatan terakumulasi. */
  'MENIT_TERLAMBAT',
  /** Menit lembur terakumulasi. */
  'MENIT_LEMBUR',
  /** Masa kerja dalam bulan, pada akhir periode. */
  'MASA_KERJA_BULAN',
  /** Jumlah hari kalender dalam periode. */
  'HARI_KALENDER',
] as const;

export interface ComponentInput {
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'INFO';
  calcMethod: 'FIXED' | 'FORMULA' | 'PER_DAY' | 'PER_HOUR' | 'PERCENTAGE';
  amount?: number | null | undefined;
  expression?: string | null | undefined;
  rate?: number | null | undefined;
  baseComponentCode?: string | null | undefined;
  taxable: boolean;
  bpjsBase: boolean;
  sortOrder: number;
}

/** Variabel yang tersedia bagi sebuah komponen: variabel dasar + kode komponen lain. */
export async function availableVariables(
  tx: TenantClient,
  tenantId: string,
  exceptCode?: string,
): Promise<string[]> {
  const components = await tx.payrollComponent.findMany({
    where: { tenantId, isActive: true },
    select: { code: true },
  });

  return [
    ...BASE_VARIABLES,
    ...components.map((c) => c.code).filter((code) => code !== exceptCode),
  ];
}

export async function upsertComponent(
  tx: TenantClient,
  tenantId: string,
  input: ComponentInput,
  actorUserId: string,
): Promise<{ id: string; code: string }> {
  if (input.calcMethod === 'FORMULA') {
    const variables = await availableVariables(tx, tenantId, input.code);
    const check = checkFormula(input.expression ?? '', variables);

    if (!check.ok) {
      // Ditolak DI SINI, bukan saat run. Formula yang salah ditemukan pada
      // tanggal 25 berarti seribu slip tertahan sampai seseorang memperbaikinya.
      throw new ComponentError(
        `Formula tidak sah: ${check.error?.message ?? 'tidak dapat dibaca'}`,
        'invalid_formula',
      );
    }

    // Komponen yang merujuk dirinya sendiri sudah tertolak lewat `exceptCode`,
    // tetapi siklus tidak langsung — A→B→A — baru terlihat setelah seluruh
    // grafnya diperiksa. Itu dilakukan di bawah, setelah barisnya tersimpan.
  }

  if (input.calcMethod === 'PERCENTAGE') {
    const base = await tx.payrollComponent.findFirst({
      where: { tenantId, code: input.baseComponentCode ?? '' },
      select: { id: true },
    });
    if (!base) {
      throw new ComponentError(
        `Komponen dasar "${input.baseComponentCode}" tidak ditemukan.`,
        'not_found',
      );
    }
  }

  const data = {
    name: input.name.trim(),
    type: input.type,
    calcMethod: input.calcMethod,
    amount: input.amount != null ? new Prisma.Decimal(input.amount) : null,
    expression: input.expression?.trim() || null,
    rate: input.rate != null ? new Prisma.Decimal(input.rate) : null,
    baseComponentCode: input.baseComponentCode?.trim() || null,
    taxable: input.taxable,
    bpjsBase: input.bpjsBase,
    sortOrder: input.sortOrder,
  };

  const saved = await tx.payrollComponent.upsert({
    where: { tenantId_code: { tenantId, code: input.code.trim() } },
    create: { tenantId, code: input.code.trim(), ...data },
    update: data,
    select: { id: true, code: true },
  });

  await assertNoCycles(tx, tenantId);

  await writeAudit(tx, tenantId, {
    action: 'payroll.component.saved',
    entityType: 'payroll_component',
    entityId: saved.id,
    actorUserId,
    after: { code: saved.code, type: input.type, calcMethod: input.calcMethod },
  });

  return saved;
}

/**
 * Menolak siklus ketergantungan antar komponen.
 *
 * A memakai B, B memakai A. Perhitungannya tidak akan pernah selesai, dan pada
 * run seribu karyawan itu berarti seluruh proses payroll berhenti tanpa satu
 * pun slip terbit — pada tanggal ketika slip itu paling dibutuhkan.
 *
 * Diperiksa setiap kali komponen disimpan, bukan saat run. Siklus terbentuk
 * dari SATU perubahan, dan itulah momen paling murah untuk menolaknya: yang
 * menyimpannya masih ada di layar dan masih ingat apa yang baru ia ubah.
 */
export async function assertNoCycles(tx: TenantClient, tenantId: string): Promise<void> {
  const components = await tx.payrollComponent.findMany({
    where: { tenantId, isActive: true },
    select: { code: true, calcMethod: true, expression: true, baseComponentCode: true },
  });

  const byCode = new Map(components.map((c) => [c.code, c]));

  const dependenciesOf = (code: string): string[] => {
    const component = byCode.get(code);
    if (!component) return [];

    if (component.calcMethod === 'PERCENTAGE') {
      return component.baseComponentCode ? [component.baseComponentCode] : [];
    }
    if (component.calcMethod === 'FORMULA' && component.expression) {
      const check = checkFormula(component.expression, [...byCode.keys(), ...BASE_VARIABLES]);
      return check.variables.filter((name) => byCode.has(name));
    }
    return [];
  };

  const state = new Map<string, 'visiting' | 'done'>();
  const trail: string[] = [];

  const visit = (code: string): void => {
    const status = state.get(code);
    if (status === 'done') return;
    if (status === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(code)), code].join(' → ');
      throw new ComponentError(
        `Komponen saling bergantung membentuk lingkaran: ${cycle}. ` +
          'Perhitungannya tidak akan pernah selesai.',
        'cycle',
      );
    }

    state.set(code, 'visiting');
    trail.push(code);
    for (const dependency of dependenciesOf(code)) visit(dependency);
    trail.pop();
    state.set(code, 'done');
  };

  for (const code of byCode.keys()) visit(code);
}

/**
 * Mengurutkan komponen sesuai ketergantungannya.
 *
 * `sortOrder` yang ditetapkan admin dipakai sebagai pemecah seri, bukan sebagai
 * urutan utama. Admin yang memberi nomor urut salah akan menghasilkan komponen
 * yang dihitung sebelum yang dijadikan dasarnya — dan hasilnya nol, bukan galat.
 */
export function orderComponents<
  T extends { code: string; calcMethod: string; expression: string | null; baseComponentCode: string | null; sortOrder: number },
>(components: T[]): T[] {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const codes = new Set(byCode.keys());
  const ordered: T[] = [];
  const done = new Set<string>();

  const dependenciesOf = (component: T): string[] => {
    if (component.calcMethod === 'PERCENTAGE') {
      return component.baseComponentCode && codes.has(component.baseComponentCode)
        ? [component.baseComponentCode]
        : [];
    }
    if (component.calcMethod === 'FORMULA' && component.expression) {
      const check = checkFormula(component.expression, [...codes, ...BASE_VARIABLES]);
      return check.variables.filter((name) => codes.has(name));
    }
    return [];
  };

  const visit = (component: T): void => {
    if (done.has(component.code)) return;
    done.add(component.code);

    for (const dependency of dependenciesOf(component)) {
      const next = byCode.get(dependency);
      if (next) visit(next);
    }
    ordered.push(component);
  };

  for (const component of [...components].sort((a, b) => a.sortOrder - b.sortOrder)) {
    visit(component);
  }

  return ordered;
}

export interface SalaryAssignment {
  employeeId: string;
  componentCode: string;
  amount: number;
  effectiveFrom: Date;
  note?: string | undefined;
}

/**
 * Menetapkan nilai komponen untuk seorang karyawan, menutup baris sebelumnya.
 *
 * Baris lama DITUTUP, tidak ditimpa (P13). Kenaikan gaji bulan Juli tidak boleh
 * mengubah slip bulan Juni — dan slip Juni harus tetap dapat dihitung ulang
 * dengan angka yang berlaku saat itu, misalnya ketika ada koreksi presensi.
 */
export async function assignSalary(
  tx: TenantClient,
  tenantId: string,
  input: SalaryAssignment,
  actorUserId: string,
): Promise<{ id: string }> {
  const component = await tx.payrollComponent.findFirst({
    where: { tenantId, code: input.componentCode },
    select: { id: true, name: true },
  });
  if (!component) {
    throw new ComponentError(`Komponen "${input.componentCode}" tidak ditemukan.`, 'not_found');
  }

  const open = await tx.salaryStructure.findFirst({
    where: {
      tenantId,
      employeeId: input.employeeId,
      componentId: component.id,
      effectiveTo: null,
    },
    select: { id: true, effectiveFrom: true, amount: true },
  });

  if (open) {
    if (open.effectiveFrom >= input.effectiveFrom) {
      throw new ComponentError(
        `Sudah ada nilai berlaku sejak ${open.effectiveFrom.toISOString().slice(0, 10)}. ` +
          'Tanggal berlaku yang baru harus setelahnya.',
        'conflict',
      );
    }

    // Ditutup sehari sebelum yang baru berlaku, sehingga tidak ada hari yang
    // dicakup dua baris sekaligus maupun hari yang tidak tercakup sama sekali.
    const closeAt = new Date(input.effectiveFrom);
    closeAt.setUTCDate(closeAt.getUTCDate() - 1);

    await tx.salaryStructure.update({
      where: { id: open.id },
      data: { effectiveTo: closeAt },
    });
  }

  const created = await tx.salaryStructure.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      componentId: component.id,
      amount: new Prisma.Decimal(input.amount),
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdBy: actorUserId,
    },
    select: { id: true },
  });

  await writeAudit(tx, tenantId, {
    action: 'payroll.salary.assigned',
    entityType: 'salary_structure',
    entityId: created.id,
    actorUserId,
    // Nilai gaji TIDAK dicatat di jejak audit, hanya kolomnya. Jejak audit
    // dibaca lebih banyak orang daripada struktur gaji itu sendiri.
    before: open ? { adaNilaiSebelumnya: true } : { adaNilaiSebelumnya: false },
    after: {
      employeeId: input.employeeId,
      component: component.name,
      effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
    },
  });

  return created;
}

/** Nilai komponen yang berlaku bagi seorang karyawan pada satu tanggal. */
export async function salaryAt(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  onDate: Date,
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await tx.salaryStructure.findMany({
    where: {
      tenantId,
      employeeId,
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
    },
    include: { component: { select: { code: true } } },
  });

  return new Map(
    rows.map((row) => [row.component.code, row.amount ?? new Prisma.Decimal(0)]),
  );
}
