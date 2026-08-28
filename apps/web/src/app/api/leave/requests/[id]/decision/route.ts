import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { decideRequest, cancelRequest, LeaveError } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  approve: z.boolean(),
  comment: z.string().trim().min(4).max(500),
});

/**
 * Memutuskan pengajuan cuti.
 *
 * Kunci saldo diambil di lapisan core SEBELUM status diperiksa; alasan
 * urutannya ada di `decideRequest`. Yang perlu diketahui di sini: pada
 * persetujuan simultan, permintaan kedua dan seterusnya menerima 409 dengan
 * pesan "sudah diputuskan sebelumnya" — bukan galat basis data mentah, dan
 * bukan keberhasilan palsu.
 */
export const POST = defineRoute('POST /api/leave/requests/[id]/decision', async (req, ctx) => {
  const requestId = ctx.params['id'];
  if (!requestId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id pengajuan tidak ada', ctx.correlationId);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Keputusan wajib menyertakan komentar minimal 4 karakter.',
      ctx.correlationId,
    );
  }

  try {
    const result = await decideRequest(
      ctx.tx,
      ctx.tenantId,
      { requestId, approve: parsed.data.approve, comment: parsed.data.comment },
      ctx.userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LeaveError) {
      return apiError(
        error.kind === 'not_found' ? 404 : 409,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});

/** Membatalkan pengajuan sendiri yang belum diputuskan. */
export const DELETE = defineRoute('DELETE /api/leave/requests/[id]/decision', async (_req, ctx) => {
  const requestId = ctx.params['id'];
  if (!requestId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id pengajuan tidak ada', ctx.correlationId);
  }

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  if (!me) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Akun belum terhubung ke karyawan', ctx.correlationId);
  }

  try {
    await cancelRequest(ctx.tx, ctx.tenantId, requestId, me.id, ctx.userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof LeaveError) {
      return apiError(
        error.kind === 'not_found' ? 404 : error.kind === 'forbidden' ? 403 : 409,
        error.kind === 'forbidden' ? ErrorCode.PERMISSION_DENIED : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
