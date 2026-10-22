import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { superuserLogin, SuperuserAuthError } from '@hrms/core/platform';
import { definePublicAdminRoute, adminError } from '@/lib/define-admin-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/, 'The TOTP code must be 6 digits'),
});

export const POST = definePublicAdminRoute('POST /admin/api/auth/login', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Sengaja tidak membedakan "TOTP tidak diisi" dari "kredensial salah":
    // keduanya kegagalan yang sama bagi pemanggil.
    return adminError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials', ctx.correlationId);
  }

  try {
    return NextResponse.json(await superuserLogin(parsed.data, { ip: ctx.ip }));
  } catch (error) {
    if (error instanceof SuperuserAuthError) {
      return adminError(401, ErrorCode.INVALID_CREDENTIALS, error.message, ctx.correlationId);
    }
    throw error;
  }
});
