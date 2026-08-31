import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { checkFormula } from './formula.ts';

/**
 * Salary components and per-employee salary structures (PLAN/12 P5).
 *
 * Two guards live here, and both prevent a failure that only appears on the 25th
 * when a thousand payslips are due tomorrow:
 *
 *   1. **A formula is validated when SAVED**, not when the run happens. A
 *      formula referencing an unknown variable is refused on the configuration
 *      screen.
 *   2. **Dependency cycles are refused.** Component A using B using A would make
 *      the calculation loop forever — and on a thousand-employee run, "loop
 *      forever" means the whole payroll process stops with not one payslip issued.
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
 * The variables available to a formula.
 *
 * This list is the contract between the configuration screen and the calculation
 * engine. Adding a variable here without providing it in `buildScope` would let
 * through a formula that then fails during a run — precisely the failure this
 * formula validation exists to prevent.
 */
export const BASE_VARIABLES = [
  /** Scheduled working days in this period. */
  'HARI_KERJA',
  /** Days present according to the attendance recap. */
  'HARI_HADIR',
  /** Days absent with no explanation. */
  'HARI_ALFA',
  /** Days of unpaid leave. */
  'HARI_CUTI_TANPA_GAJI',
  /** Accumulated minutes late. */
  'MENIT_TERLAMBAT',
  /** Accumulated minutes of overtime. */
  'MENIT_LEMBUR',
  /** Length of service in months, at the end of the period. */
  'MASA_KERJA_BULAN',
  /** The number of calendar days in the period. */
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

/** The variables available to a component: the base variables plus other component codes. */
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
      // Refused HERE, not during a run. A bad formula found on the 25th means a
      // thousand payslips held up until somebody fixes it.
      throw new ComponentError(
        `Formula tidak sah: ${check.error?.message ?? 'tidak dapat dibaca'}`,
        'invalid_formula',
      );
    }

    // A component referencing itself is already refused through `exceptCode`, but
    // an indirect cycle — A→B→A — only appears once the whole graph is examined.
    // That happens below, after its row is stored.
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
 * Refuses dependency cycles between components.
 *
 * A uses B, B uses A. Its calculation would never finish, and on a
 * thousand-employee run that means the whole payroll process stops with not one
 * payslip issued — on the date those payslips are needed most.
 *
 * Checked every time a component is saved, not during a run. A cycle is formed
 * by ONE change, and that is the cheapest moment to refuse it: whoever saved it
 * is still on the screen and still remembers what they just changed.
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
 * Orders components by their dependencies.
 *
 * The `sortOrder` an admin sets is used as a tie-breaker, not as the primary
 * order. An admin numbering them wrongly would have a component computed before
 * the one it is based on — and the result is zero, not an error.
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
 * Sets a component's value for an employee, closing the previous row.
 *
 * The old row is CLOSED, not overwritten (P13). A July raise must not change a
 * June payslip — and the June payslip must remain recomputable with the figures
 * that applied then, for instance when an attendance correction arrives.
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

    // Closed the day before the new one takes effect, so no day is covered by two
    // rows at once and no day is left uncovered.
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
    // Salary values are NOT recorded in the audit trail, only their column names.
    // The audit trail is read by more people than the salary structure itself.
    before: open ? { adaNilaiSebelumnya: true } : { adaNilaiSebelumnya: false },
    after: {
      employeeId: input.employeeId,
      component: component.name,
      effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
    },
  });

  return created;
}

/** The component values in force for an employee on one date. */
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
