import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { evaluateFormula, FormulaError } from './formula.ts';
import { orderComponents, salaryAt, BASE_VARIABLES } from './components.ts';

/**
 * The salary calculation engine (PLAN/12 P5).
 *
 * **What is NOT here: PPh21, PTKP, and BPJS.** All three are locked behind Gate
 * C — a payroll expert engaged, 30 real payslips as test cases, and spike S1
 * passing 30/30. Writing them from one's own reading of the regulations produces
 * numbers that look plausible and are wrong, and miscalculating an employee's
 * tax is a legal liability borne by the customer, not by us.
 *
 * What IS here is the framework: configured components computed by their method,
 * in dependency order, with every figure leaving a trace. Once Gate C opens,
 * PPh21 and BPJS enter as `DEDUCTION`-type components reading
 * `statutory_configs` — with no change to this engine.
 *
 * Three properties are maintained, all of them from the Phase 5 DoD:
 *
 *   1. **Deterministic.** Recalculating from the same snapshot gives an
 *      identical result, even if the upstream attendance changed afterwards.
 *   2. **Every figure has a trace.** The formula and its variable values are
 *      stored, so an employee's challenge is answered with a breakdown rather
 *      than an argument.
 *   3. **One run per period.** Enforced by a partial unique index in the
 *      database, not by an application check.

export class PayrollError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'invalid_state' | 'calculation_failed',
    readonly employeeId?: string,
  ) {
    super(message);
    this.name = 'PayrollError';
  }
}

/**
 * A snapshot of the upstream data for one employee in one period.
 *
 * Stored on the payslip, and a recalculation reads it from there rather than
 * from attendance. That is what makes recalculation deterministic: correcting
 * last month's attendance does not silently change a payslip already issued.
 */
export interface PayrollSnapshot {
  hariKerja: number;
  hariHadir: number;
  hariAlfa: number;
  hariCutiTanpaGaji: number;
  menitTerlambat: number;
  menitLembur: number;
  masaKerjaBulan: number;
  hariKalender: number;
}

/** Builds the snapshot from the attendance and leave recaps for that period. */
export async function buildSnapshot(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  year: number,
  month: number,
): Promise<PayrollSnapshot> {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const hariKalender = to.getUTCDate();

  const days = await tx.attendanceDay.findMany({
    where: { tenantId, employeeId, workDate: { gte: from, lte: to } },
    select: { status: true, lateMinutes: true, overtimeMinutes: true },
  });

  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { joinDate: true },
  });
  if (!employee) throw new PayrollError('Karyawan tidak ditemukan', 'not_found', employeeId);

  // Unpaid leave is counted separately: it is the only leave type that reduces
  // wages, and merging it with absence would erase the difference between
  // someone with formal permission and someone who simply did not turn up.
  const unpaidLeave = await tx.leaveRequest.count({
    where: {
      tenantId,
      employeeId,
      status: { in: ['APPROVED', 'TAKEN'] },
      startDate: { lte: to },
      endDate: { gte: from },
      leaveType: { isPaid: false },
    },
  });

  const masaKerjaBulan = Math.max(
    0,
    Math.floor((to.getTime() - employee.joinDate.getTime()) / (30.44 * 86_400_000)),
  );

  return {
    hariKerja: days.filter((d) => d.status !== 'HOLIDAY' && d.status !== 'DAY_OFF').length,
    hariHadir: days.filter((d) => d.status === 'PRESENT' || d.status === 'LATE').length,
    hariAlfa: days.filter((d) => d.status === 'ABSENT').length,
    hariCutiTanpaGaji: unpaidLeave,
    menitTerlambat: days.reduce((sum, d) => sum + d.lateMinutes, 0),
    menitLembur: days.reduce((sum, d) => sum + d.overtimeMinutes, 0),
    masaKerjaBulan,
    hariKalender,
  };
}

/** Translates the snapshot into the variables a formula recognises. */
function scopeFrom(snapshot: PayrollSnapshot): Record<string, number> {
  return {
    HARI_KERJA: snapshot.hariKerja,
    HARI_HADIR: snapshot.hariHadir,
    HARI_ALFA: snapshot.hariAlfa,
    HARI_CUTI_TANPA_GAJI: snapshot.hariCutiTanpaGaji,
    MENIT_TERLAMBAT: snapshot.menitTerlambat,
    MENIT_LEMBUR: snapshot.menitLembur,
    MASA_KERJA_BULAN: snapshot.masaKerjaBulan,
    HARI_KALENDER: snapshot.hariKalender,
  };
}

export interface CalculatedLine {
  componentId: string;
  componentCode: string;
  componentName: string;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'INFO';
  amount: Prisma.Decimal;
  sortOrder: number;
  expression: string | null;
  inputs: Record<string, string>;
  explanation: string;
}

export interface CalculatedPayslip {
  employeeId: string;
  gross: Prisma.Decimal;
  deduction: Prisma.Decimal;
  net: Prisma.Decimal;
  snapshot: PayrollSnapshot;
  lines: CalculatedLine[];
}

const ZERO = new Prisma.Decimal(0);

/**
 * Computes one payslip.
 *
 * Pure: it writes nothing. Separated from storage so it can be tested without a
 * database, and so the golden regression tests — 30 cases from real payslips run
 * on every commit — do not require the whole system to be running.
 */
export async function calculatePayslip(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  year: number,
  month: number,
  snapshot?: PayrollSnapshot,
): Promise<CalculatedPayslip> {
  const shot = snapshot ?? (await buildSnapshot(tx, tenantId, employeeId, year, month));
  const periodEnd = new Date(Date.UTC(year, month, 0));

  const components = await tx.payrollComponent.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      calcMethod: true,
      amount: true,
      expression: true,
      rate: true,
      baseComponentCode: true,
      sortOrder: true,
    },
  });

  const assigned = await salaryAt(tx, tenantId, employeeId, periodEnd);

  // Dependency order, not `sortOrder` alone. A component computed before its
  // base yields zero — a number that looks like a decision.
  const ordered = orderComponents(components);

  const scope: Record<string, number | Prisma.Decimal> = scopeFrom(shot);
  const lines: CalculatedLine[] = [];

  for (const component of ordered) {
    let amount: Prisma.Decimal;
    let expression: string | null = null;
    let explanation: string;
    const inputs: Record<string, string> = {};

    switch (component.calcMethod) {
      case 'FIXED': {
        // A per-employee value beats the component default. Basic salary genuinely
        // differs per person; the component only provides a fallback.
        amount = assigned.get(component.code) ?? component.amount ?? ZERO;
        explanation = assigned.has(component.code)
          ? 'Nilai tetap dari struktur gaji karyawan'
          : 'Nilai tetap bawaan komponen';
        break;
      }

      case 'PER_DAY': {
        const perDay = assigned.get(component.code) ?? component.amount ?? ZERO;
        amount = perDay.times(shot.hariHadir);
        inputs['tarif_per_hari'] = perDay.toString();
        inputs['HARI_HADIR'] = String(shot.hariHadir);
        explanation = `${perDay.toString()} × ${shot.hariHadir} hari hadir`;
        break;
      }

      case 'PER_HOUR': {
        const perHour = assigned.get(component.code) ?? component.amount ?? ZERO;
        const hours = new Prisma.Decimal(shot.menitLembur).dividedBy(60);
        amount = perHour.times(hours);
        inputs['tarif_per_jam'] = perHour.toString();
        inputs['MENIT_LEMBUR'] = String(shot.menitLembur);
        explanation = `${perHour.toString()} × ${hours.toFixed(2)} jam lembur`;
        break;
      }

      case 'PERCENTAGE': {
        const base = component.baseComponentCode
          ? (scope[component.baseComponentCode] ?? ZERO)
          : ZERO;
        const baseDecimal = base instanceof Prisma.Decimal ? base : new Prisma.Decimal(base);
        const rate = component.rate ?? ZERO;
        amount = baseDecimal.times(rate);
        inputs[component.baseComponentCode ?? 'dasar'] = baseDecimal.toString();
        inputs['tarif'] = rate.toString();
        explanation = `${rate.times(100).toString()}% dari ${component.baseComponentCode}`;
        break;
      }

      case 'FORMULA': {
        expression = component.expression;
        try {
          amount = evaluateFormula(component.expression ?? '0', scope);
        } catch (error) {
          // The employee's name is included: a thousand-person run that fails
          // without naming anyone forces HR to guess which row is the problem.
          throw new PayrollError(
            `Komponen "${component.code}" gagal dihitung: ` +
              (error instanceof FormulaError ? error.message : String(error)),
            'calculation_failed',
            employeeId,
          );
        }

        // Only the variables actually referenced are recorded. Storing the whole
        // scope on every line produces a trace that cannot be read — and a trace
        // nobody reads is the same as no trace at all.
        for (const name of [...BASE_VARIABLES, ...components.map((c) => c.code)]) {
          if (component.expression?.includes(name)) {
            inputs[name] = String(scope[name] ?? '');
          }
        }
        explanation = `Formula: ${component.expression}`;
        break;
      }

      default:
        amount = ZERO;
        explanation = 'Metode tidak dikenali';
    }

    // Rounded to whole rupiah on every line, not only on the total. Rounding only
    // at the end makes the payslip's lines fail to add up to its total — and
    // whoever reads it will add them up themselves and find a one-rupiah
    // discrepancy that cannot be explained.
    amount = amount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

    scope[component.code] = amount;

    lines.push({
      componentId: component.id,
      componentCode: component.code,
      componentName: component.name,
      type: component.type,
      amount,
      sortOrder: component.sortOrder,
      expression,
      inputs,
      explanation,
    });
  }

  const gross = lines
    .filter((line) => line.type === 'EARNING')
    .reduce((sum, line) => sum.plus(line.amount), ZERO);
  const deduction = lines
    .filter((line) => line.type === 'DEDUCTION')
    .reduce((sum, line) => sum.plus(line.amount), ZERO);

  return {
    employeeId,
    gross,
    deduction,
    net: gross.minus(deduction),
    snapshot: shot,
    lines: lines.sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

export interface RunResult {
  runId: string;
  runNumber: string;
  employeeCount: number;
  totalGross: string;
  totalNet: string;
  failures: Array<{ employeeId: string; reason: string }>;
}

/**
 * The run calculation, split into chunks that are EACH committed.
 *
 * Before this, the whole run happened inside a single HTTP request transaction.
 * A comment right here promised "kill the worker mid-calculation → it continues
 * with no duplicate payslip", and the code did skip payslips that already
 * existed — but that promise **could never be kept**, because not one payslip
 * was committed until the whole run finished.
 *
 * What actually happened on a large run:
 *
 *   1. A Prisma interactive transaction has a five-second default limit.
 *   2. The `hrms_app` role has a 15-second `statement_timeout`.
 *   3. A thousand-employee run passes both.
 *   4. The transaction is rolled back. EVERY payslip already computed is lost.
 *   5. HR presses "Calculate" again. The set of existing payslips is empty.
 *      Everything repeats from zero, and fails again at the same second.
 *
 * That run would never finish, however many times it was tried, and all HR saw
 * was a transaction error explaining nothing. The recovery code was there from
 * the start; what was missing was any chance for it to be useful.
 *
 * So its shape is now three parts called in SEPARATE transactions — `startRun`,
 * `calculateBatch` repeatedly, then `finishRun`. Every chunk is committed, so
 * progress survives a process that dies.
 */

/**
 * Employees per transaction.
 *
 * Chosen so one chunk finishes well below the worker role's `statement_timeout`
 * (5 minutes). Larger means fewer commits and slightly more speed; smaller means
 * less work lost when a process dies. Fifty sits on the side one does not regret.
 */
export const BATCH_SIZE = 50;

export interface RunResult {
  runId: string;
  runNumber: string;
  employeeCount: number;
  totalGross: string;
  totalNet: string;
  failures: Array<{ employeeId: string; reason: string }>;
}

export interface BatchFailure {
  employeeId: string;
  reason: string;
}

/**
 * Marks the run as calculating, and returns the employees still outstanding.
 *
 * Only ids are returned — a thousand ids fit in memory, a thousand salary
 * snapshots do not.
 */
export async function startRun(
  tx: TenantClient,
  tenantId: string,
  runId: string,
): Promise<{ periodYear: number; periodMonth: number; pending: string[] }> {
  const run = await tx.payrollRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new PayrollError('Run tidak ditemukan', 'not_found');

  if (run.status !== 'DRAFT' && run.status !== 'CALCULATING' && run.status !== 'FAILED') {
    throw new PayrollError(
      `Run berstatus ${run.status} tidak dapat dihitung ulang. Batalkan dan buat run baru.`,
      'invalid_state',
    );
  }

  await tx.payrollRun.update({
    where: { id: run.id },
    data: { status: 'CALCULATING', lastError: null },
  });

  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    select: { id: true },
    orderBy: { employeeNumber: 'asc' },
  });

  const existing = await tx.payslip.findMany({
    where: { tenantId, runId: run.id },
    select: { employeeId: true },
  });
  const alreadyDone = new Set(existing.map((p) => p.employeeId));

  return {
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    pending: employees.map((e) => e.id).filter((id) => !alreadyDone.has(id)),
  };
}

/**
 * Computes one chunk of employees.
 *
 * A failing employee is returned in `failures` and the chunk carries on. One
 * incomplete salary structure must not hold back 999 other people's payslips —
 * and HR who receive "payroll failed" with no detail can do nothing with that
 * sentence.
 *
 * Existing payslips are checked again here, not only in `startRun`. There is a
 * gap between the two, and in that gap another process may already have computed
 * some — which is what happens when HR presses "Calculate" twice.
 */
export async function calculateBatch(
  tx: TenantClient,
  tenantId: string,
  runId: string,
  employeeIds: readonly string[],
  periodYear: number,
  periodMonth: number,
): Promise<{ calculated: number; failures: BatchFailure[] }> {
  const existing = await tx.payslip.findMany({
    where: { tenantId, runId, employeeId: { in: [...employeeIds] } },
    select: { employeeId: true },
  });
  const alreadyDone = new Set(existing.map((p) => p.employeeId));

  const failures: BatchFailure[] = [];
  let calculated = 0;

  for (const employeeId of employeeIds) {
    if (alreadyDone.has(employeeId)) continue;

    let payslipData: CalculatedPayslip;
    try {
      payslipData = await calculatePayslip(tx, tenantId, employeeId, periodYear, periodMonth);
    } catch (error) {
      failures.push({
        employeeId,
        reason: error instanceof Error ? error.message : 'Gagal dihitung',
      });
      continue;
    }

    const payslip = await tx.payslip.create({
      data: {
        tenantId,
        runId,
        employeeId,
        gross: payslipData.gross,
        deduction: payslipData.deduction,
        net: payslipData.net,
        snapshot: payslipData.snapshot as never,
      },
      select: { id: true },
    });

    await tx.payslipLine.createMany({
      data: payslipData.lines.map((line) => ({
        tenantId,
        payslipId: payslip.id,
        componentId: line.componentId,
        componentCode: line.componentCode,
        componentName: line.componentName,
        type: line.type,
        amount: line.amount,
        sortOrder: line.sortOrder,
      })),
    });

    await tx.calculationTrace.createMany({
      data: payslipData.lines.map((line) => ({
        tenantId,
        payslipId: payslip.id,
        componentCode: line.componentCode,
        expression: line.expression,
        inputs: line.inputs as never,
        result: line.amount,
        explanation: line.explanation,
      })),
    });

    calculated += 1;
  }

  return { calculated, failures };
}

/**
 * Closes the run: sums it up, sets the status, and audits it.
 *
 * The totals are recomputed from the DATABASE, not accumulated in memory.
 * Memory accumulation is only correct when one process finishes the whole run —
 * and the entire point of this split is that it need not be. A process that dies
 * on the seventh chunk and is continued by another would report the last seven
 * chunks' total as the whole company's total, and that number enters a report
 * with not one error.
 */
export async function finishRun(
  tx: TenantClient,
  tenantId: string,
  runId: string,
  failures: readonly BatchFailure[],
  actorUserId: string,
): Promise<RunResult> {
  const totals = await tx.payslip.aggregate({
    where: { tenantId, runId },
    _count: { _all: true },
    _sum: { gross: true, deduction: true, net: true },
  });

  const counted = totals._count._all;

  const updated = await tx.payrollRun.update({
    where: { id: runId },
    data: {
      status: failures.length > 0 && counted === 0 ? 'FAILED' : 'CALCULATED',
      employeeCount: counted,
      totalGross: totals._sum.gross ?? ZERO,
      totalDeduction: totals._sum.deduction ?? ZERO,
      totalNet: totals._sum.net ?? ZERO,
      calculatedAt: new Date(),
      lastError:
        failures.length > 0
          ? `${failures.length} karyawan gagal dihitung. Lihat rincian pada hasil run.`
          : null,
    },
  });

  await writeAudit(tx, tenantId, {
    action: 'payroll.run.calculated',
    entityType: 'payroll_run',
    entityId: runId,
    actorUserId,
    after: { employeeCount: counted, failures: failures.length },
  });

  return {
    runId,
    runNumber: updated.runNumber,
    employeeCount: counted,
    totalGross: (totals._sum.gross ?? ZERO).toString(),
    totalNet: (totals._sum.net ?? ZERO).toString(),
    failures: [...failures],
  };
}

/**
 * Marks a run as failed, with its cause.
 *
 * Called by the worker when a chunk throws something that is not a per-employee
 * failure — a dropped connection, a missing tenant. A run left CALCULATING
 * forever is a run whose button nobody will press again: `startRun` would accept
 * it back, but nobody knows it may be retried.
 * ia boleh dicoba.
 * `updateMany` with a status condition, not `update`. A run that another process
 * has meanwhile finished computing must not be marked failed by a message that
 * arrives late.
 */
export async function failRun(
  tx: TenantClient,
  tenantId: string,
  runId: string,
  reason: string,
): Promise<void> {
  await tx.payrollRun.updateMany({
    where: { id: runId, tenantId, status: 'CALCULATING' },
    data: { status: 'FAILED', lastError: reason },
  });
}
