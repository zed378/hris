import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { generateSchedules, ScheduleError } from '@hrms/core/attendance';
import { writeAudit } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: z.string().uuid().optional(),
});

export const GET = defineRoute('GET /api/attendance/schedules', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = rangeSchema.safeParse({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    ...(url.searchParams.get('employeeId')
      ? { employeeId: url.searchParams.get('employeeId') }
      : {}),
  });
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sebutkan rentang tanggal: from=YYYY-MM-DD&to=YYYY-MM-DD',
      ctx.correlationId,
    );
  }

  const from = new Date(`${parsed.data.from}T00:00:00.000Z`);
  const to = new Date(`${parsed.data.to}T00:00:00.000Z`);

  const schedules = await ctx.tx.schedule.findMany({
    where: {
      tenantId: ctx.tenantId,
      workDate: { gte: from, lte: to },
      ...(parsed.data.employeeId ? { employeeId: parsed.data.employeeId } : {}),
    },
    orderBy: [{ workDate: 'asc' }],
    // Dibatasi supaya permintaan tanpa `employeeId` pada rentang setahun tidak
    // menarik ratusan ribu baris ke dalam memori proses web.
    take: 5_000,
    select: {
      id: true,
      employeeId: true,
      workDate: true,
      isDayOff: true,
      shift: { select: { id: true, code: true, name: true } },
    },
  });

  return NextResponse.json({
    schedules: schedules.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      workDate: s.workDate.toISOString().slice(0, 10),
      isDayOff: s.isDayOff,
      shift: s.shift,
    })),
    truncated: schedules.length === 5_000,
  });
});

const generateSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1).max(1_000),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftId: z.string().uuid().nullable().default(null),
  /** 0 = Minggu … 6 = Sabtu. Senin–Jumat biasa = [0, 6]. */
  dayOffWeekdays: z.array(z.number().int().min(0).max(6)).default([0, 6]),
  /**
   * Menimpa jadwal yang sudah ada harus DIMINTA, tidak pernah menjadi default.
   * Baris yang ada mungkin hasil penyesuaian tangan — tukar shift, libur
   * pengganti yang sudah disepakati — dan menghapusnya diam-diam adalah cara
   * kehilangan kepercayaan pada penjadwalan dalam satu kali pakai.
   */
  overwrite: z.boolean().default(false),
});

export const POST = defineRoute('POST /api/attendance/schedules', async (req, ctx) => {
  const parsed = generateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data pembangkitan jadwal tidak sah',
      ctx.correlationId,
    );
  }

  const input = parsed.data;

  try {
    const result = await generateSchedules(ctx.tx, ctx.tenantId, {
      employeeIds: input.employeeIds,
      startDate: new Date(`${input.from}T00:00:00.000Z`),
      endDate: new Date(`${input.to}T00:00:00.000Z`),
      shiftId: input.shiftId,
      dayOffWeekdays: input.dayOffWeekdays as ReadonlyArray<0 | 1 | 2 | 3 | 4 | 5 | 6>,
      overwrite: input.overwrite,
    });

    // Diaudit karena jadwal menentukan siapa tercatat ALFA. Pembangkitan yang
    // salah pola memotong gaji orang, dan pertanyaan "siapa yang mengubah
    // jadwal saya" harus punya jawaban.
    await writeAudit(ctx.tx, ctx.tenantId, {
      action: 'attendance.schedule.generate',
      entityType: 'schedule',
      actorUserId: ctx.userId,
      correlationId: ctx.correlationId,
      after: {
        from: input.from,
        to: input.to,
        shiftId: input.shiftId,
        dayOffWeekdays: input.dayOffWeekdays,
        overwrite: input.overwrite,
        ...result,
      },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleError) {
      const status = error.kind === 'not_found' ? 404 : 400;
      return apiError(
        status,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        error.kind === 'range_too_long'
          ? `${error.message} Bagi menjadi beberapa pembangkitan.`
          : error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
