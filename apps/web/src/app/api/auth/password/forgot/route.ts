import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantCodeSchema, emailSchema } from '@hrms/contracts';
import { requestPasswordReset } from '@hrms/core/auth';
import { definePublicRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ tenantCode: tenantCodeSchema, email: emailSchema });

/**
 * Selalu 204, apa pun yang terjadi — termasuk untuk masukan yang tidak sah.
 *
 * Balasan yang membedakan "email terdaftar" dari "tidak terdaftar" mengubah
 * endpoint ini menjadi alat pencacah alamat email karyawan sebuah perusahaan,
 * dan daftar itu justru yang paling berguna bagi penyerang.
 */
export const POST = definePublicRoute('POST /api/auth/password/forgot', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (parsed.success) await requestPasswordReset(parsed.data, ctx);
  return new NextResponse(null, { status: 204 });
});
