import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { Prisma, writeAudit } from '@hrms/db';
import { revertJointLeave } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * National holidays and joint leave (document 10 §6).
 *
 * The table has existed since the attendance module was built and is read by two
 * modules — attendance for the `HOLIDAY` status, leave to exclude it from
 * balance deductions — but **no path filled it** other than the seed, and the
 * seed holds only five hand-written dates in 2026.
 *
 * The consequences compound, and all of them are silent:
 *
 *   - 2027 has no holidays at all. Eid, Nyepi, Vesak, Christmas — none of them.
 *   - Leave requested across Eid **deducts balance** for days the office is
 *     closed.
 *   - If HR recomputes a full month of attendance before payroll, every holiday
 *     is recorded ABSENT, and that absence count is what the salary formula uses
 *     to dock wages.
 * Not one of the three produces an error. What appears is a leave balance that
 * shrinks for no reason and a payslip smaller than it should be — for someone
 * with no way of proving it.
 *
 *
 * Indonesian national holiday dates are set by a joint ministerial decree each
 * year and some follow the Hijri calendar, so they **cannot be computed in
 * advance** by any code. They have to be enterable by the tenant. That is what
 * this endpoint provides.
 */

export const GET = defineRoute('GET /api/attendance/holidays', async (req, ctx) => {
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year') ?? new Date().getUTCFullYear());

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Tahun tidak sah', ctx.correlationId);
  }

  const holidays = await ctx.tx.holiday.findMany({
    where: {
      tenantId: ctx.tenantId,
      date: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lte: new Date(Date.UTC(year, 11, 31)),
      },
    },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, name: true, isJointLeave: true },
  });

  return NextResponse.json({
    year,
    holidays: holidays.map((holiday) => ({
      id: holiday.id,
      date: holiday.date.toISOString().slice(0, 10),
      name: holiday.name,
      isJointLeave: holiday.isJointLeave,
    })),
  });
});

const createSchema = z.object({
  entries: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().trim().min(2).max(120),
        /**
         * Joint leave DEDUCTS from the annual leave allowance; a national holiday
         * does not.
         *
         * This distinction is not nomenclature. The joint ministerial decree makes
         * joint leave a deduction from the 12-day annual allowance, so marking it
         * wrongly means the company gives four extra paid days off per employee
         * per year — or deducts an allowance that should have stayed whole.
         */
        isJointLeave: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(60),
});

export const POST = defineRoute('POST /api/attendance/holidays', async (req, ctx) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Daftar hari libur tidak sah',
      ctx.correlationId,
    );
  }

  let created = 0;
  let updated = 0;
  let reverted = 0;

  for (const entry of parsed.data.entries) {
    const date = new Date(`${entry.date}T00:00:00.000Z`);

    // An upsert, not a create. Pasting an updated decree list mid-year is
    // something HR genuinely does — the government does revise joint leave dates
    // — and refusing it with a 409 would force them to delete the dates one at a
    // time first.
    const existing = await ctx.tx.holiday.findFirst({
      where: { tenantId: ctx.tenantId, date },
      select: { id: true, isJointLeave: true },
    });

    if (existing) {
      await ctx.tx.holiday.update({
        where: { id: existing.id },
        data: { name: entry.name, isJointLeave: entry.isJointLeave },
      });

      // Downgraded from joint leave to an ordinary holiday: its allowance
      // deduction is returned. Without this, an HR correction only works in one
      // direction — mistakenly flagging one date deducts a hundred employees'
      // allowance, and undoing it returns nothing. The government does revise
      // joint leave dates mid-year.
      if (existing.isJointLeave && !entry.isJointLeave) {
        reverted += (await revertJointLeave(ctx.tx, ctx.tenantId, existing.id, ctx.userId)).days;
      }

      updated += 1;
    } else {
      await ctx.tx.holiday.create({
        data: {
          tenantId: ctx.tenantId,
          date,
          name: entry.name,
          isJointLeave: entry.isJointLeave,
        },
      });
      created += 1;
    }
  }

  // Audited because holidays decide who is recorded ABSENT and how much leave
  // balance is deducted. Quietly deleting one holiday date changes someone's pay.
  await writeAudit(ctx.tx, ctx.tenantId, {
    action: 'attendance.holiday.upserted',
    entityType: 'holiday',
    actorUserId: ctx.userId,
    correlationId: ctx.correlationId,
    after: { created, updated, revertedDays: reverted, entries: parsed.data.entries.length },
  });

  return NextResponse.json({ created, updated, revertedDays: reverted }, { status: 201 });
});

const deleteSchema = z.object({ id: z.string().uuid() });

export const DELETE = defineRoute('DELETE /api/attendance/holidays', async (req, ctx) => {
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id tidak sah', ctx.correlationId);
  }

  const holiday = await ctx.tx.holiday.findFirst({
    where: { id: parsed.data.id, tenantId: ctx.tenantId },
    select: { id: true, date: true, name: true, isJointLeave: true },
  });
  if (!holiday) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Hari libur tidak ditemukan', ctx.correlationId);
  }

  // Returned BEFORE its row is deleted. Once deleted, nothing connects the
  // ledger deduction to the date that caused it, and a hundred employees' balance
  // is left deducted with no origin.
  const reverted = holiday.isJointLeave
    ? await revertJointLeave(ctx.tx, ctx.tenantId, holiday.id, ctx.userId)
    : { employees: 0, days: 0 };

  try {
    await ctx.tx.holiday.delete({ where: { id: holiday.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return apiError(
        409,
        ErrorCode.CONFLICT,
        'Hari libur ini masih dirujuk data lain dan tidak dapat dihapus.',
        ctx.correlationId,
      );
    }
    throw error;
  }

  await writeAudit(ctx.tx, ctx.tenantId, {
    action: 'attendance.holiday.deleted',
    entityType: 'holiday',
    entityId: holiday.id,
    actorUserId: ctx.userId,
    correlationId: ctx.correlationId,
    before: {
      date: holiday.date.toISOString().slice(0, 10),
      name: holiday.name,
      isJointLeave: holiday.isJointLeave,
      revertedDays: reverted.days,
    },
  });

  return NextResponse.json({ deleted: holiday.id, reverted });
});
