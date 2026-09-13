import { NextResponse } from 'next/server';
import { loginRequestSchema, ErrorCode } from '@hrms/contracts';
import { login, AuthError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';
import { setRefreshCookie } from '@/lib/session-cookie.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/login', async (req, ctx) => {
  const parsed = loginRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Incomplete or invalid login data',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const result = await login(parsed.data, ctx);

    // The refresh token does NOT travel in the body. It exists only as an
    // httpOnly cookie, so page JavaScript never holds it and therefore cannot
    // persist it anywhere (PLAN/11 §5.3).
    const { refreshToken, ...body } = result;
    const response = NextResponse.json(body);
    setRefreshCookie(response, refreshToken);
    return response;
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
