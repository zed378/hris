import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, passwordSchema } from '@hrms/contracts';
import { completePasswordReset, ActionTokenError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(20).max(256), newPassword: passwordSchema });

export const POST = definePublicRoute('POST /api/auth/password/reset', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data tidak lengkap atau kata sandi kurang dari 12 karakter',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    await completePasswordReset(parsed.data, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ActionTokenError) {
      return apiError(400, ErrorCode.TOKEN_INVALID, error.message, ctx.correlationId);
    }
    throw error;
  }
});
