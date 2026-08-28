import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { Prisma } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/payroll/runs', async (_req, ctx) => {
  const runs = await ctx.tx.payrollRun.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
    take: 60,
  });

  return NextResponse.json({
    runs: runs.map((run) => ({
      id: run.id,
      runNumber: run.runNumber,
      runType: run.runType,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      status: run.status,
      employeeCount: run.employeeCount,
      totalGross: Number(run.totalGross),
      totalNet: Number(run.totalNet),
      calculatedAt: run.calculatedAt?.toISOString() ?? null,
      approvedAt: run.approvedAt?.toISOString() ?? null,
      lastError: run.lastError,
    })),
  });
});

const schema = z.object({
  periodYear: z.number().int().min(2000).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  runType: z.enum(['MONTHLY', 'THR', 'BONUS', 'ADJUSTMENT']).default('MONTHLY'),
});

/**
 * Membuat run penggajian.
 *
 * Duplikat ditolak indeks unik parsial di basis data, bukan pemeriksaan
 * aplikasi. Dua klik tombol "Hitung" yang tiba bersamaan akan sama-sama membaca
 * "belum ada run untuk periode ini" — dan menghasilkan dua run yang keduanya
 * menerbitkan slip untuk orang yang sama.
 *
 * Itulah DoD Fase 5: "menjalankan run yang sama dua kali menghasilkan tepat
 * satu run".
 */
export const POST = defineRoute('POST /api/payroll/runs', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Periode run tidak sah.',
      ctx.correlationId,
    );
  }

  const { periodYear, periodMonth, runType } = parsed.data;
  const runNumber = `${runType === 'MONTHLY' ? 'GAJI' : runType}-${periodYear}-${String(periodMonth).padStart(2, '0')}`;

  try {
    const run = await ctx.tx.payrollRun.create({
      data: {
        tenantId: ctx.tenantId,
        runNumber,
        runType,
        periodYear,
        periodMonth,
        createdBy: ctx.userId,
      },
      select: { id: true, runNumber: true, status: true },
    });
    return NextResponse.json(run, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // 409 dengan pesan yang menyebutkan periodenya. "Run sudah ada" tanpa
      // menyebut periode mana memaksa HR menebak apa yang bentrok.
      return apiError(
        409,
        ErrorCode.CONFLICT,
        `Run untuk ${String(periodMonth).padStart(2, '0')}/${periodYear} sudah ada. ` +
          'Buka run yang ada, atau batalkan lebih dulu bila ingin mengulang dari awal.',
        ctx.correlationId,
      );
    }
    throw error;
  }
});
