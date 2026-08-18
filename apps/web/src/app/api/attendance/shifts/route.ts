import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/attendance/shifts', async (_req, ctx) => {
  const shifts = await ctx.tx.shift.findMany({
    where: { tenantId: ctx.tenantId, isActive: true },
    orderBy: { startMinute: 'asc' },
    select: {
      id: true, code: true, name: true, startMinute: true,
      endMinute: true, graceMinutes: true, breakMinutes: true,
    },
  });

  return NextResponse.json({
    shifts: shifts.map((s) => ({
      ...s,
      // Jam ditampilkan sebagai HH:MM; menitnya tetap dikirim supaya klien tidak
      // perlu mengurai kembali untuk menghitung.
      start: minutesToClock(s.startMinute),
      end: minutesToClock(s.endMinute),
      crossesMidnight: s.endMinute > 1440,
    })),
  });
});

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(80),
  startMinute: z.number().int().min(0).max(1439),
  // Sampai 2880 supaya shift malam (22:00-06:00 = 1320-1800) dapat dinyatakan
  // tanpa tanggal.
  endMinute: z.number().int().min(1).max(2880),
  graceMinutes: z.number().int().min(0).max(120).default(10),
  breakMinutes: z.number().int().min(0).max(240).default(60),
});

export const POST = defineRoute('POST /api/attendance/shifts', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || parsed.data.endMinute <= parsed.data.startMinute) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data shift tidak sah. Jam selesai harus setelah jam mulai.',
      ctx.correlationId,
    );
  }

  try {
    const created = await ctx.tx.shift.create({
      data: { tenantId: ctx.tenantId, ...parsed.data, code: parsed.data.code.toLowerCase() },
      select: { id: true },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(409, ErrorCode.CONFLICT, 'Kode shift sudah dipakai', ctx.correlationId);
    }
    throw error;
  }
});

function minutesToClock(minutes: number): string {
  const m = minutes % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
