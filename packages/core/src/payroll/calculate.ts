import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { evaluateFormula, FormulaError } from './formula.ts';
import { orderComponents, salaryAt, BASE_VARIABLES } from './components.ts';

/**
 * Mesin perhitungan gaji (PLAN/12 F5).
 *
 * **Yang TIDAK ada di sini: PPh21, PTKP, dan BPJS.** Ketiganya terkunci Gerbang
 * C — ahli payroll terikat, 30 slip nyata sebagai kasus uji, dan spike S1 lulus
 * 30/30. Menuliskannya dari pembacaan peraturan sendiri berarti menghasilkan
 * angka yang terlihat masuk akal dan salah, dan salah menghitung pajak karyawan
 * adalah kewajiban hukum yang ditanggung pelanggan, bukan kami.
 *
 * Yang ADA di sini adalah kerangkanya: komponen terkonfigurasi dihitung menurut
 * metodenya, dalam urutan ketergantungan, dengan setiap angka meninggalkan
 * jejak. Ketika Gerbang C terbuka, PPh21 dan BPJS masuk sebagai komponen
 * bertipe `DEDUCTION` yang membaca `statutory_configs` — tanpa mengubah mesin ini.
 *
 * Tiga sifat yang dijaga, dan seluruhnya berasal dari DoD Fase 5:
 *
 *   1. **Deterministik.** Menghitung ulang dari potret yang sama memberi hasil
 *      identik, meski presensi hulu berubah kemudian.
 *   2. **Setiap angka punya jejak.** Formula dan nilai variabelnya disimpan,
 *      sehingga sanggahan karyawan dijawab dengan rincian, bukan perdebatan.
 *   3. **Satu run per periode.** Ditegakkan indeks unik parsial di basis data,
 *      bukan pemeriksaan aplikasi.
 */

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
 * Potret data hulu untuk satu karyawan pada satu periode.
 *
 * Disimpan pada slip, dan perhitungan ulang membacanya dari sana alih-alih
 * dari presensi. Itulah yang membuat rekalkulasi deterministik: koreksi
 * presensi bulan lalu tidak diam-diam mengubah slip yang sudah terbit.
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

/** Membangun potret dari rekap presensi dan cuti pada periode tersebut. */
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

  // Cuti tanpa gaji dihitung terpisah: ia satu-satunya jenis cuti yang memotong
  // upah, dan menggabungkannya dengan alfa akan menghilangkan perbedaan antara
  // orang yang izin resmi dan orang yang tidak datang tanpa kabar.
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

/** Menerjemahkan potret menjadi variabel yang dikenal formula. */
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
 * Menghitung satu slip.
 *
 * Murni: tidak menulis apa pun. Dipisahkan dari penyimpanan supaya dapat diuji
 * tanpa basis data, dan supaya uji regresi emas — 30 kasus dari slip nyata yang
 * dijalankan setiap commit — tidak menuntut seluruh sistem berjalan.
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

  // Urutan ketergantungan, bukan `sortOrder` semata. Komponen yang dihitung
  // sebelum dasarnya menghasilkan nol — angka yang terlihat seperti keputusan.
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
        // Nilai per karyawan menang atas nilai bawaan komponen. Gaji pokok
        // memang berbeda per orang; komponen hanya menyediakan cadangan.
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
          // Nama karyawan disertakan: run seribu orang yang gagal tanpa
          // menyebut siapa memaksa HR menebak baris mana yang bermasalah.
          throw new PayrollError(
            `Komponen "${component.code}" gagal dihitung: ` +
              (error instanceof FormulaError ? error.message : String(error)),
            'calculation_failed',
            employeeId,
          );
        }

        // Hanya variabel yang benar-benar dirujuk yang dicatat. Menyimpan
        // seluruh scope pada setiap baris menghasilkan jejak yang tidak dapat
        // dibaca — dan jejak yang tidak dibaca sama saja tidak ada.
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

    // Dibulatkan ke rupiah penuh pada setiap baris, bukan hanya pada total.
    // Membulatkan hanya di akhir membuat jumlah baris pada slip tidak sama
    // dengan totalnya — dan yang membacanya akan menghitung sendiri lalu
    // menemukan selisih satu rupiah yang tidak dapat dijelaskan.
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
 * Menghitung seluruh karyawan pada satu run.
 *
 * Slip yang sudah ada DILEWATI, bukan dihitung ulang. Itulah yang memenuhi DoD
 * "mematikan worker di tengah kalkulasi → dilanjutkan tanpa slip ganda":
 * menjalankan ulang run yang terputus melanjutkan dari tempat ia berhenti.
 *
 * Karyawan yang gagal dicatat pada `failures` dan run tetap berjalan. Satu
 * struktur gaji yang belum lengkap tidak boleh menahan slip 999 orang lain —
 * dan HR yang menerima "payroll gagal" tanpa keterangan tidak dapat berbuat
 * apa-apa dengan kalimat itu.
 */
export async function calculateRun(
  tx: TenantClient,
  tenantId: string,
  runId: string,
  actorUserId: string,
): Promise<RunResult> {
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
  });

  const existing = await tx.payslip.findMany({
    where: { tenantId, runId: run.id },
    select: { employeeId: true },
  });
  const alreadyDone = new Set(existing.map((p) => p.employeeId));

  const failures: RunResult['failures'] = [];
  let totalGross = ZERO;
  let totalDeduction = ZERO;
  let totalNet = ZERO;

  for (const employee of employees) {
    if (alreadyDone.has(employee.id)) continue;

    let calculated: CalculatedPayslip;
    try {
      calculated = await calculatePayslip(
        tx,
        tenantId,
        employee.id,
        run.periodYear,
        run.periodMonth,
      );
    } catch (error) {
      failures.push({
        employeeId: employee.id,
        reason: error instanceof Error ? error.message : 'Gagal dihitung',
      });
      continue;
    }

    const payslip = await tx.payslip.create({
      data: {
        tenantId,
        runId: run.id,
        employeeId: employee.id,
        gross: calculated.gross,
        deduction: calculated.deduction,
        net: calculated.net,
        snapshot: calculated.snapshot as never,
      },
      select: { id: true },
    });

    await tx.payslipLine.createMany({
      data: calculated.lines.map((line) => ({
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
      data: calculated.lines.map((line) => ({
        tenantId,
        payslipId: payslip.id,
        componentCode: line.componentCode,
        expression: line.expression,
        inputs: line.inputs as never,
        result: line.amount,
        explanation: line.explanation,
      })),
    });

    totalGross = totalGross.plus(calculated.gross);
    totalDeduction = totalDeduction.plus(calculated.deduction);
    totalNet = totalNet.plus(calculated.net);
  }

  const counted = await tx.payslip.count({ where: { tenantId, runId: run.id } });

  const updated = await tx.payrollRun.update({
    where: { id: run.id },
    data: {
      status: failures.length > 0 && counted === 0 ? 'FAILED' : 'CALCULATED',
      employeeCount: counted,
      totalGross,
      totalDeduction,
      totalNet,
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
    entityId: run.id,
    actorUserId,
    after: { employeeCount: counted, failures: failures.length },
  });

  return {
    runId: run.id,
    runNumber: updated.runNumber,
    employeeCount: counted,
    totalGross: totalGross.toString(),
    totalNet: totalNet.toString(),
    failures,
  };
}
