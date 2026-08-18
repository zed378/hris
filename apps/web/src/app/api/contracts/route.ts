import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { createContract, ContractError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  employeeId: z.string().uuid(),
  contractNumber: z.string().trim().min(1).max(64),
  type: z.enum(['PKWTT', 'PKWT', 'MAGANG', 'HARIAN', 'BORONGAN']),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const POST = defineRoute('POST /api/contracts', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data kontrak tidak lengkap',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const created = await createContract(ctx.tx, ctx.tenantId, parsed.data, {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(409, ErrorCode.CONFLICT, 'Nomor kontrak sudah dipakai', ctx.correlationId);
    }
    if (error instanceof ContractError) {
      const status = error.kind === 'not_found' ? 404 : error.kind === 'invalid' ? 400 : 409;
      return apiError(status, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
