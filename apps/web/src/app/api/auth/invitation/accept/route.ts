import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, passwordSchema } from '@hrms/contracts';
import { acceptInvitation, ActionTokenError } from '@hrms/core/auth';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(20).max(256), password: passwordSchema });

/**
 * Mengembalikan `tenantCode` dan `email` supaya layar berikutnya dapat mengisi
 * form login. Keduanya sudah diketahui pemegang token — ia baru saja memakainya
 * untuk memasang kata sandi akun itu — sehingga tidak ada yang dibocorkan.
 */
export const POST = definePublicRoute('POST /api/auth/invitation/accept', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Kata sandi minimal 12 karakter',
      ctx.correlationId,
    );
  }

  try {
    return NextResponse.json(await acceptInvitation(parsed.data, ctx));
  } catch (error) {
    if (error instanceof ActionTokenError) {
      return apiError(400, ErrorCode.TOKEN_INVALID, error.message, ctx.correlationId);
    }
    throw error;
  }
});
