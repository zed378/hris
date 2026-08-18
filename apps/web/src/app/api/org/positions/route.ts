import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { listPositions, createPosition } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/org/positions', async (_req, ctx) =>
  NextResponse.json({ positions: await listPositions(ctx.tx, ctx.tenantId) }),
);

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(120),
  /// Kecil = lebih senior. Dipakai matriks persetujuan dan pelaporan.
  level: z.number().int().min(0).max(99).default(0),
});

export const POST = defineRoute('POST /api/org/positions', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data jabatan tidak sah', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await createPosition(ctx.tx, ctx.tenantId, parsed.data, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(409, ErrorCode.CONFLICT, 'Kode jabatan sudah dipakai', ctx.correlationId);
    }
    throw error;
  }
});
