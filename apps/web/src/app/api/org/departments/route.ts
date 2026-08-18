import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { listDepartments, createDepartment, OrgError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/org/departments', async (_req, ctx) =>
  NextResponse.json({ departments: await listDepartments(ctx.tx, ctx.tenantId) }),
);

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(120),
  parentId: z.string().uuid().nullable().optional(),
});

export const POST = defineRoute('POST /api/org/departments', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data departemen tidak sah', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await createDepartment(ctx.tx, ctx.tenantId, parsed.data, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(409, ErrorCode.CONFLICT, 'Kode departemen sudah dipakai', ctx.correlationId);
    }
    if (error instanceof OrgError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
