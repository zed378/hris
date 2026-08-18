import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { refresh, AuthError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';
import { readRefreshCookie, setRefreshCookie, clearRefreshCookie } from '@/lib/session-cookie.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/refresh', async (req, ctx) => {
  const token = readRefreshCookie(req);
  if (!token) {
    return apiError(401, ErrorCode.TOKEN_INVALID, 'Tidak ada sesi', ctx.correlationId);
  }

  try {
    const { refreshToken, ...body } = await refresh(token, ctx);
    const response = NextResponse.json(body);
    setRefreshCookie(response, refreshToken);
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      // Cookie dihapus pada setiap kegagalan. Membiarkan cookie mati tetap
      // terpasang membuat klien terus mencoba menyegarkan sesi yang sudah tidak
      // ada, dan pengguna melihat kegagalan berulang alih-alih layar masuk.
      const response = apiError(401, error.code, error.message, ctx.correlationId);
      clearRefreshCookie(response as unknown as NextResponse);
      return response;
    }
    throw error;
  }
});
