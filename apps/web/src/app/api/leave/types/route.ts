import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/leave/types', async (_req, ctx) => {
  const types = await ctx.tx.leaveType.findMany({
    where: { tenantId: ctx.tenantId, isActive: true },
    orderBy: { code: 'asc' },
  });

  return NextResponse.json({
    types: types.map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      isPaid: type.isPaid,
      accrualMethod: type.accrualMethod,
      defaultQuotaDays: Number(type.defaultQuotaDays),
      minServiceMonths: type.minServiceMonths,
      requiresAttachment: type.requiresAttachment,
      deductFromBalance: type.deductFromBalance,
      colorHex: type.colorHex,
    })),
  });
});

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(120),
  isPaid: z.boolean().default(true),
  accrualMethod: z
    .enum(['ANNUAL_GRANT', 'MONTHLY_ACCRUAL', 'ANNIVERSARY', 'UNLIMITED', 'NONE'])
    .default('ANNUAL_GRANT'),
  defaultQuotaDays: z.number().min(0).max(365).default(12),
  maxCarryOverDays: z.number().min(0).max(365).default(0),
  minServiceMonths: z.number().int().min(0).max(120).default(12),
  requiresAttachment: z.boolean().default(false),
  deductFromBalance: z.boolean().default(true),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#3b82f6'),
});

export const POST = defineRoute('POST /api/leave/types', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Jenis cuti tidak lengkap.',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const created = await ctx.tx.leaveType.create({
    data: { tenantId: ctx.tenantId, ...parsed.data },
  });

  return NextResponse.json({ id: created.id, code: created.code }, { status: 201 });
});
