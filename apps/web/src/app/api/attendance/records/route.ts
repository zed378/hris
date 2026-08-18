import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { recalculateDate, closePeriod } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rekap presensi seluruh karyawan pada rentang tanggal. */
export const GET = defineRoute('GET /api/attendance/records', async (req, ctx) => {
  const url = new URL(req.url);
  const from = new Date(url.searchParams.get('from') ?? new Date().toISOString().slice(0, 10));
  const to = new Date(url.searchParams.get('to') ?? from.toISOString().slice(0, 10));

  const days = await ctx.tx.attendanceDay.findMany({
    where: { tenantId: ctx.tenantId, workDate: { gte: from, lte: to } },
    orderBy: [{ workDate: 'desc' }],
    take: 1000,
    select: {
      id: true, employeeId: true, workDate: true, status: true,
      checkIn: true, checkOut: true, lateMinutes: true,
      workMinutes: true, overtimeMinutes: true, isLocked: true,
    },
  });

  const employees = await ctx.tx.employee.findMany({
    where: { tenantId: ctx.tenantId, id: { in: [...new Set(days.map((d) => d.employeeId))] } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  return NextResponse.json({
    days: days.map((d) => ({
      id: d.id,
      workDate: d.workDate.toISOString().slice(0, 10),
      employee: byId.get(d.employeeId) ?? null,
      status: d.status,
      checkIn: d.checkIn?.toISOString() ?? null,
      checkOut: d.checkOut?.toISOString() ?? null,
      lateMinutes: d.lateMinutes,
      workMinutes: d.workMinutes,
      overtimeMinutes: d.overtimeMinutes,
      isLocked: d.isLocked,
    })),
    summary: {
      present: days.filter((d) => d.status === 'PRESENT').length,
      late: days.filter((d) => d.status === 'LATE').length,
      absent: days.filter((d) => d.status === 'ABSENT').length,
    },
  });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('recalculate'), date: z.coerce.date() }),
  z.object({
    action: z.literal('close-period'),
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
  }),
]);

/**
 * Dua operasi pemeliharaan rekap.
 *
 * `recalculate` menghitung ulang satu tanggal dari punch_logs — dipakai setelah
 * koreksi manual atau setelah presensi bertanda ditinjau. Hari yang sudah
 * terkunci penutupan periode dilewati, bukan ditimpa.
 *
 * `close-period` mengunci sebulan penuh dan menyimpan ringkasannya. Setelah itu
 * koreksi presensi tidak lagi mengubah angka yang dipakai payroll.
 */
export const POST = defineRoute('POST /api/attendance/records', async (req, ctx) => {
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Aksi tidak dikenal', ctx.correlationId);
  }

  if (parsed.data.action === 'recalculate') {
    const result = await recalculateDate(ctx.tx, ctx.tenantId, parsed.data.date);
    return NextResponse.json(result);
  }

  const result = await closePeriod(
    ctx.tx,
    ctx.tenantId,
    parsed.data.year,
    parsed.data.month,
    ctx.userId,
  );
  return NextResponse.json(result);
});
