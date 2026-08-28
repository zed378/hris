import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { submitRequest, listRequests, LeaveError } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READ_ALL = 'leave.request.read.all';
const READ_TEAM = 'leave.request.read.team';

/** Memetakan kind galat cuti ke kode HTTP yang berarti bagi klien. */
function statusFor(kind: LeaveError['kind']): number {
  switch (kind) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    // 409, bukan 400: permintaannya sah, keadaan sistem yang menolaknya. HR
    // yang melihat 400 akan mencari kesalahan pada formulirnya.
    case 'insufficient_balance':
    case 'overlap':
    case 'invalid_state':
      return 409;
    case 'not_entitled':
      return 403;
  }
}

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
      'Akun Anda belum terhubung ke data karyawan. Hubungi admin HR.',
      ctx.correlationId,
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
      'Pengajuan cuti tidak lengkap. Jenis, tanggal, alasan, dan penyetuju wajib diisi.',
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
      'Akun Anda belum terhubung ke data karyawan. Hubungi admin HR.',
      ctx.correlationId,
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
    if (error instanceof LeaveError) {
      return apiError(
        statusFor(error.kind),
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
