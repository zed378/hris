import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, tenantCodeSchema, emailSchema, passwordSchema } from '@hrms/contracts';
import { hashPassword } from '@hrms/core/auth';
import { provisionTenant, TenantCodeTakenError } from '@hrms/core/tenant';
import { definePublicRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  tenantCode: tenantCodeSchema,
  companyName: z.string().trim().min(2).max(120),
  ownerEmail: emailSchema,
  ownerFullName: z.string().trim().min(2).max(120),
  ownerPassword: passwordSchema,
});

/**
 * Pendaftaran mandiri — "perusahaan baru mendaftar" dari DoD Fase 1.
 *
 * Hashing dilakukan di sini, bukan di dalam `provisionTenant`. Lapisan aplikasi
 * adalah composition root: ia satu-satunya tempat yang boleh mengenal modul
 * `auth` dan `tenant` sekaligus. Menaruhnya di dalam modul `tenant` akan membuat
 * keduanya saling mengimpor, dan siklus itu menjadi dua service yang saling
 * memanggil pada saat pemecahan nanti.
 */
export const POST = definePublicRoute('POST /api/tenants/register', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data pendaftaran tidak lengkap atau tidak sah',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const { ownerPassword, ...rest } = parsed.data;

  try {
    const result = await provisionTenant(
      { ...rest, ownerPasswordHash: await hashPassword(ownerPassword) },
      ctx,
    );
    return NextResponse.json(
      { ...result, trialEndsAt: result.trialEndsAt?.toISOString() ?? null },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TenantCodeTakenError) {
      return apiError(409, ErrorCode.CONFLICT, error.message, ctx.correlationId, {
        tenantCode: ['Kode perusahaan ini sudah dipakai'],
      });
    }
    throw error;
  }
});
