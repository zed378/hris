import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { assignSalary, ComponentError } from '@hrms/core/payroll';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Struktur gaji seorang karyawan, beserta riwayatnya.
 *
 * Riwayat ditampilkan penuh, bukan hanya nilai berjalan. Pertanyaan "sejak
 * kapan gaji saya segini" adalah pertanyaan yang selalu muncul, dan jawabannya
 * ada di baris-baris yang sudah ditutup — bukan di baris yang berlaku sekarang.
 */
export const GET = defineRoute('GET /api/payroll/salary', async (req, ctx) => {
  const employeeId = new URL(req.url).searchParams.get('employeeId');
  if (!employeeId) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sebutkan employeeId.',
      ctx.correlationId,
    );
  }

  const rows = await ctx.tx.salaryStructure.findMany({
    where: { tenantId: ctx.tenantId, employeeId },
    include: { component: { select: { code: true, name: true, type: true } } },
    orderBy: [{ effectiveFrom: 'desc' }],
  });

  return NextResponse.json({
    structures: rows.map((row) => ({
      id: row.id,
      componentCode: row.component.code,
      componentName: row.component.name,
      type: row.component.type,
      amount: row.amount === null ? null : Number(row.amount),
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo?.toISOString().slice(0, 10) ?? null,
      // Baris yang masih berlaku ditandai, supaya layar tidak perlu menebaknya
      // dari `effectiveTo === null`.
      current: row.effectiveTo === null,
      note: row.note,
    })),
  });
});

const schema = z.object({
  employeeId: z.string().uuid(),
  componentCode: z.string().trim().min(1).max(32),
  amount: z.number().min(0).max(1_000_000_000_000),
  effectiveFrom: z.coerce.date(),
  note: z.string().trim().max(500).optional(),
});

export const POST = defineRoute('POST /api/payroll/salary', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Penetapan gaji tidak lengkap.',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    return NextResponse.json(
      await assignSalary(ctx.tx, ctx.tenantId, parsed.data, ctx.userId),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ComponentError) {
      return apiError(
        error.kind === 'not_found' ? 404 : 409,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
