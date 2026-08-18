import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, emailSchema } from '@hrms/contracts';
import { listUsers, inviteUser, IamError } from '@hrms/core/iam';
import { issueActionToken } from '@hrms/core/auth';
import { publishEvent } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/users', async (req, ctx) => {
  const url = new URL(req.url);
  return NextResponse.json(
    await listUsers(ctx.tx, ctx.tenantId, {
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
    }),
  );
});

const inviteSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  roleCode: z.string().trim().min(2).max(64),
});

/**
 * Mengundang pengguna baru.
 *
 * Pembuatan pengguna, penerbitan token undangan, dan penerbitan event berjalan
 * di transaksi request yang sama. Bila salah satu gagal, tidak ada pengguna
 * setengah jadi yang menunggu undangan yang tidak pernah dikirim.
 *
 * Emailnya sendiri dikirim konsumer event, bukan di jalur ini — penyedia email
 * yang sedang bermasalah tidak boleh membuat undangan gagal.
 */
export const POST = defineRoute('POST /api/users', async (req, ctx) => {
  const parsed = inviteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data undangan tidak lengkap',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const { userId } = await inviteUser(ctx.tx, ctx.tenantId, parsed.data, {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });

    const token = await issueActionToken(ctx.tx, {
      tenantId: ctx.tenantId,
      userId,
      purpose: 'INVITATION',
      createdBy: ctx.userId,
      ip: ctx.ip,
    });

    await publishEvent(ctx.tx, ctx.tenantId, {
      topic: 'iam.user.invited',
      payload: {
        tenantId: ctx.tenantId,
        userId,
        email: parsed.data.email,
        token: token.raw,
        expiresAt: token.expiresAt.toISOString(),
      },
      correlationId: ctx.correlationId,
    });

    return NextResponse.json({ userId, status: 'INVITED' }, { status: 201 });
  } catch (error) {
    if (error instanceof IamError) {
      const status = error.kind === 'conflict' ? 409 : 404;
      const code = error.kind === 'conflict' ? ErrorCode.CONFLICT : ErrorCode.NOT_FOUND;
      return apiError(status, code, error.message, ctx.correlationId);
    }
    throw error;
  }
});
