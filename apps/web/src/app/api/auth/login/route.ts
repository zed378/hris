import { NextResponse } from 'next/server';
import { loginRequestSchema, ErrorCode } from '@hrms/contracts';
import { login, AuthError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/login', async (req, ctx) => {
  const parsed = loginRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data login tidak lengkap atau tidak sah',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const result = await login(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      const status =
        error.code === ErrorCode.ACCOUNT_LOCKED ? 423
        : error.code === ErrorCode.TENANT_SUSPENDED ? 403
        : 401;
      const response = apiError(status, error.code, error.message, ctx.correlationId);
      if (error.retryAfterSeconds !== undefined) {
        response.headers.set('Retry-After', String(error.retryAfterSeconds));
      }
      return response;
    }
    throw error;
  }
});
