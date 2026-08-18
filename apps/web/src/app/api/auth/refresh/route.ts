import { NextResponse } from 'next/server';
import { refreshRequestSchema, ErrorCode } from '@hrms/contracts';
import { refresh, AuthError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/refresh', async (req, ctx) => {
  const parsed = refreshRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Refresh token tidak ada', ctx.correlationId);
  }

  try {
    return NextResponse.json(await refresh(parsed.data.refreshToken, ctx));
  } catch (error) {
    if (error instanceof AuthError) {
      // Pemakaian ulang token dijawab 401 seperti token tidak sah lainnya.
      // Membedakannya akan memberi tahu penyerang bahwa token curiannya sempat
      // sah — informasi yang tidak perlu ia miliki. Sisi kita tetap mencatatnya
      // sebagai insiden di jejak audit.
      return apiError(401, error.code, error.message, ctx.correlationId);
    }
    throw error;
  }
});
