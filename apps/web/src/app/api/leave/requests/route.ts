import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode, ErrorReason } from '@hrms/contracts';
import { submitRequest, listRequests, LeaveError } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { leaveErrorResponse } from '@/lib/leave-error.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READ_ALL = 'leave.request.read.all';
const READ_TEAM = 'leave.request.read.team';

export const GET = defineRoute('GET /api/leave/requests', async (req, ctx) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') ?? 'own';

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  // Cakupan dibatasi izin, bukan parameter. Klien yang meminta `all` tanpa izin
  // menerima daftarnya sendiri — bukan galat, karena itu memang yang berhak ia
  // lihat, dan bukan daftar penuh, karena itu yang tidak berhak (P9).
  const canReadAll = ctx.access.permissions.includes(READ_ALL);
  const canReadTeam = ctx.access.permissions.includes(READ_TEAM);

  if (scope === 'inbox') {
    return NextResponse.json({
      requests: await listRequests(ctx.tx, ctx.tenantId, {
        approverId: ctx.userId,
        status: 'PENDING',
      }),
    });
  }

  if (scope === 'all' && (canReadAll || canReadTeam)) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    return NextResponse.json({
      requests: await listRequests(ctx.tx, ctx.tenantId, {
        ...(from && to ? { from: new Date(from), to: new Date(to) } : {}),
      }),
    });
  }

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

  return NextResponse.json({
    requests: await listRequests(ctx.tx, ctx.tenantId, { employeeId: me.id }),
  });
});

const schema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  isHalfDay: z.boolean().default(false),
  reason: z.string().trim().min(4).max(500),
  attachmentKey: z.string().max(255).nullable().optional(),
  approverId: z.string().uuid(),
});

/**
 * Mengajukan cuti untuk diri sendiri.
 *
 * `employeeId` diturunkan dari sesi, tidak pernah dari badan request. Menerima
 * `employeeId` dari klien akan membuat siapa pun dapat mengambil jatah cuti
 * orang lain.
 */
export const POST = defineRoute('POST /api/leave/requests', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Incomplete leave request. Type, dates, reason, and approver are required.',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
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
    const request = await submitRequest(
      ctx.tx,
      ctx.tenantId,
      { ...parsed.data, employeeId: me.id },
      ctx.userId,
    );
    return NextResponse.json(request, { status: 201 });
  } catch (error) {
    if (error instanceof LeaveError) return leaveErrorResponse(error, ctx.correlationId);
    throw error;
  }
});
