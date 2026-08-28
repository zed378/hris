import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READ_ALL = 'payroll.payslip.read.all';

/**
 * Slip gaji, beserta rincian perhitungannya.
 *
 * Otorisasinya berlapis dan lapisan kedua yang menanggung beban: pemegang
 * `payroll.payslip.read.all` melihat slip siapa pun, karyawan biasa hanya
 * slipnya sendiri. Slip gaji orang lain adalah salah satu data paling sensitif
 * dalam sistem — ia mengungkap posisi tawar seseorang di dalam perusahaan.
 *
 * Jejak perhitungan disertakan. Saat karyawan menyanggah gajinya, jawaban yang
 * dapat dipakai adalah rinciannya, bukan "begitu hasil sistemnya".
 */
export const GET = defineRoute('GET /api/payroll/payslips', async (req, ctx) => {
  const url = new URL(req.url);
  const payslipId = url.searchParams.get('id');

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  const canReadAll = ctx.access.permissions.includes(READ_ALL);

  if (!payslipId) {
    // Daftar: slip sendiri, kecuali pemegang izin baca-semua yang menyebut
    // `employeeId` secara eksplisit.
    const requested = url.searchParams.get('employeeId');
    const employeeId = canReadAll && requested ? requested : me?.id;

    if (!employeeId) {
      return apiError(
        404,
        ErrorCode.NOT_FOUND,
        'Akun Anda belum terhubung ke data karyawan.',
        ctx.correlationId,
      );
    }

    const slips = await ctx.tx.payslip.findMany({
      where: { tenantId: ctx.tenantId, employeeId },
      include: { run: { select: { runNumber: true, periodYear: true, periodMonth: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });

    return NextResponse.json({
      payslips: slips.map((slip) => ({
        id: slip.id,
        runNumber: slip.run.runNumber,
        periodYear: slip.run.periodYear,
        periodMonth: slip.run.periodMonth,
        // Slip run yang belum disetujui TIDAK ditampilkan angkanya kepada
        // karyawan: angka yang berubah setelah orang melihatnya menimbulkan
        // pertanyaan yang lebih mahal daripada menunggu persetujuan.
        released: slip.run.status === 'APPROVED' || slip.run.status === 'PAID',
        gross: Number(slip.gross),
        deduction: Number(slip.deduction),
        net: Number(slip.net),
      })),
    });
  }

  const slip = await ctx.tx.payslip.findFirst({
    where: { id: payslipId, tenantId: ctx.tenantId },
    include: {
      run: { select: { runNumber: true, periodYear: true, periodMonth: true, status: true } },
      lines: { orderBy: { sortOrder: 'asc' } },
      traces: true,
    },
  });

  if (!slip) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Slip tidak ditemukan', ctx.correlationId);
  }
  if (!canReadAll && slip.employeeId !== me?.id) {
    return apiError(403, ErrorCode.PERMISSION_DENIED, 'Bukan slip Anda', ctx.correlationId);
  }

  const tracesByCode = new Map(slip.traces.map((trace) => [trace.componentCode, trace]));

  return NextResponse.json({
    payslip: {
      id: slip.id,
      runNumber: slip.run.runNumber,
      periodYear: slip.run.periodYear,
      periodMonth: slip.run.periodMonth,
      released: slip.run.status === 'APPROVED' || slip.run.status === 'PAID',
      gross: Number(slip.gross),
      deduction: Number(slip.deduction),
      net: Number(slip.net),
      snapshot: slip.snapshot,
      lines: slip.lines.map((line) => {
        const trace = tracesByCode.get(line.componentCode);
        return {
          code: line.componentCode,
          name: line.componentName,
          type: line.type,
          amount: Number(line.amount),
          // Rincian per baris. Inilah yang membedakan slip yang dapat
          // dipertanggungjawabkan dari slip yang hanya berisi angka.
          explanation: trace?.explanation ?? null,
          expression: trace?.expression ?? null,
          inputs: trace?.inputs ?? null,
        };
      }),
    },
  });
});
