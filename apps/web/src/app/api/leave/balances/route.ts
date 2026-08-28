import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { readBalances, adjustBalance, readLedger, LeaveError } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MANAGE = 'leave.balance.manage';

/**
 * Saldo cuti.
 *
 * Tanpa `employeeId`, mengembalikan saldo penanya sendiri. Dengan `employeeId`,
 * menuntut izin kelola — saldo cuti orang lain adalah informasi kepegawaian,
 * bukan informasi umum, dan mengetahui sisa cuti seseorang cukup untuk menduga
 * hal-hal tentang kesehatan atau urusan keluarganya.
 */
export const GET = defineRoute('GET /api/leave/balances', async (req, ctx) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('employeeId');
  const year = Number(url.searchParams.get('year') ?? new Date().getFullYear());

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  let employeeId = requested;
  if (!employeeId) {
    if (!me) {
      return apiError(
        404,
        ErrorCode.NOT_FOUND,
        'Akun Anda belum terhubung ke data karyawan.',
        ctx.correlationId,
      );
    }
    employeeId = me.id;
  } else if (!ctx.access.permissions.includes(MANAGE) && me?.id !== employeeId) {
    return apiError(
      403,
      ErrorCode.PERMISSION_DENIED,
      'Tidak berizin melihat saldo karyawan lain',
      ctx.correlationId,
    );
  }

  const balances = await readBalances(ctx.tx, ctx.tenantId, employeeId, year);

  // Buku besar diminta terpisah lewat `ledgerFor`, bukan disertakan selalu:
  // riwayat mutasi seluruh jenis cuti untuk setiap pembukaan halaman adalah
  // ratusan baris yang hampir tidak pernah dilihat.
  const balanceId = url.searchParams.get('ledgerFor');
  const ledger = balanceId ? await readLedger(ctx.tx, ctx.tenantId, balanceId) : undefined;

  return NextResponse.json({ balances, ...(ledger ? { ledger } : {}) });
});

const adjustSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  periodYear: z.number().int().min(2000).max(2100),
  days: z.number().min(-365).max(365),
  reason: z.string().trim().min(4).max(500),
});

/** Penyesuaian manual saldo. Selalu berbuku besar dan selalu diaudit. */
export const POST = defineRoute('POST /api/leave/balances', async (req, ctx) => {
  const parsed = adjustSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Penyesuaian saldo wajib menyertakan jumlah hari dan alasan.',
      ctx.correlationId,
    );
  }

  try {
    return NextResponse.json(await adjustBalance(ctx.tx, ctx.tenantId, parsed.data, ctx.userId));
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
