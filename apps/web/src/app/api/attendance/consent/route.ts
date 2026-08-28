import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { readConsents, recordConsent } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Persetujuan pemrosesan data presensi milik diri sendiri (dokumen 10 §8.2 PR2).
 *
 * `employeeId` diturunkan dari sesi dan tidak pernah dari badan request.
 * Persetujuan yang dapat diberikan atas nama orang lain bukan persetujuan — dan
 * ini satu-satunya endpoint dalam sistem yang benar-benar tidak boleh punya
 * varian "untuk karyawan lain", termasuk untuk HR.
 */

async function resolveSelf(ctx: {
  tx: { employee: { findFirst: (args: never) => Promise<{ id: string } | null> } };
  tenantId: string;
  email: string;
}): Promise<string | null> {
  const me = await (
    ctx.tx.employee.findFirst as unknown as (args: unknown) => Promise<{ id: string } | null>
  )({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  return me?.id ?? null;
}

const NOT_LINKED = 'Akun Anda belum terhubung ke data karyawan. Hubungi admin HR.';

export const GET = defineRoute('GET /api/attendance/consent', async (_req, ctx) => {
  const employeeId = await resolveSelf(ctx);
  if (!employeeId) {
    return apiError(404, ErrorCode.NOT_FOUND, NOT_LINKED, ctx.correlationId);
  }

  return NextResponse.json({ consents: await readConsents(ctx.tx, ctx.tenantId, employeeId) });
});

const schema = z.object({
  type: z.enum(['LOCATION', 'PHOTO', 'BIOMETRIC']),
  grant: z.boolean(),
});

export const POST = defineRoute('POST /api/attendance/consent', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Keputusan persetujuan tidak dikenali.',
      ctx.correlationId,
    );
  }

  const employeeId = await resolveSelf(ctx);
  if (!employeeId) {
    return apiError(404, ErrorCode.NOT_FOUND, NOT_LINKED, ctx.correlationId);
  }

  const consents = await recordConsent(
    ctx.tx,
    ctx.tenantId,
    employeeId,
    { type: parsed.data.type, grant: parsed.data.grant, ip: ctx.ip ?? null },
    ctx.userId,
  );

  return NextResponse.json({ consents });
});
