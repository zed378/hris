import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, ErrorReason } from '@hrms/contracts';
import { decideRequest, cancelRequest, LeaveError } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { leaveErrorResponse } from '@/lib/leave-error.ts';

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
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Missing request id', ctx.correlationId);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'A decision needs a comment of at least 4 characters.',
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
    if (error instanceof LeaveError) return leaveErrorResponse(error, ctx.correlationId);
    throw error;
  }
});

/** Membatalkan pengajuan sendiri yang belum diputuskan. */
export const DELETE = defineRoute('DELETE /api/leave/requests/[id]/decision', async (_req, ctx) => {
  const requestId = ctx.params['id'];
  if (!requestId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Missing request id', ctx.correlationId);
  }

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  if (!me) {
    return apiError(
      404,
      ErrorCode.NOT_FOUND,
      'This account is not linked to an employee record',
      ctx.correlationId,
      undefined,
      ErrorReason.ACCOUNT_NOT_LINKED,
    );
  }

  try {
    await cancelRequest(ctx.tx, ctx.tenantId, requestId, me.id, ctx.userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof LeaveError) return leaveErrorResponse(error, ctx.correlationId);
    throw error;
  }
});
