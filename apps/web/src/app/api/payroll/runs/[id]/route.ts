import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { PayrollError } from '@hrms/core/payroll';
import { EventTopic } from '@hrms/contracts';
import { publishEvent, writeAudit } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APPROVE = 'payroll.run.approve';

export const GET = defineRoute('GET /api/payroll/runs/[id]', async (_req, ctx) => {
  const runId = ctx.params['id'];
  if (!runId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id run tidak ada', ctx.correlationId);
  }

  const run = await ctx.tx.payrollRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } });
  if (!run) return apiError(404, ErrorCode.NOT_FOUND, 'Run tidak ditemukan', ctx.correlationId);

  const payslips = await ctx.tx.payslip.findMany({
    where: { tenantId: ctx.tenantId, runId },
    orderBy: { createdAt: 'asc' },
    take: 2000,
    select: { id: true, employeeId: true, gross: true, deduction: true, net: true },
  });

  const employees = await ctx.tx.employee.findMany({
    where: { tenantId: ctx.tenantId, id: { in: payslips.map((p) => p.employeeId) } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  return NextResponse.json({
    run: {
      id: run.id,
      runNumber: run.runNumber,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      status: run.status,
      employeeCount: run.employeeCount,
      totalGross: Number(run.totalGross),
      totalDeduction: Number(run.totalDeduction),
      totalNet: Number(run.totalNet),
      lastError: run.lastError,
    },
    payslips: payslips.map((slip) => ({
      id: slip.id,
      employee: byId.get(slip.employeeId) ?? null,
      gross: Number(slip.gross),
      deduction: Number(slip.deduction),
      net: Number(slip.net),
    })),
  });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('calculate') }),
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('markPaid'), reference: z.string().trim().max(120).optional() }),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().min(4).max(500) }),
]);

/**
 * Three operations on one run: calculate, approve, cancel.
 *
 * `calculate` skips payslips that already exist, so a run interrupted halfway
 * can continue without producing duplicate payslips — the Phase 5 DoD.
 *
 * `approve` demands a permission separate from the one to run a calculation. The
 * person who calculates and the person who approves should be different; the
 * system does not force it, but separating the permissions makes it possible.
 */
export const POST = defineRoute('POST /api/payroll/runs/[id]', async (req, ctx) => {
  const runId = ctx.params['id'];
  if (!runId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id run tidak ada', ctx.correlationId);
  }

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Aksi tidak dikenal.', ctx.correlationId);
  }

  try {
    if (parsed.data.action === 'calculate') {
      /**
       * The calculation is handed to the worker rather than run here.
       *
       * Not for tidiness. A Prisma interactive transaction is capped at five
       * seconds and the `hrms_app` role is capped by a fifteen-second
       * `statement_timeout`; a thousand-employee run passes both. What happens
       * is not a slow request — its transaction is rolled back, EVERY payslip
       * already computed is lost, and the next attempt starts from zero and
       * fails at the same second. That run would never finish.
       *
       * Its status is marked CALCULATING here, in the same transaction that
       * publishes the event. Marking it in the worker would leave a window where
       * HR has pressed the button but the screen still shows DRAFT — and what
       * people do in that window is press the button again.
       * lagi.
       */
      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (!run) {
        return apiError(404, ErrorCode.NOT_FOUND, 'Run tidak ditemukan', ctx.correlationId);
      }
      if (run.status !== 'DRAFT' && run.status !== 'FAILED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          run.status === 'CALCULATING'
            ? 'Run ini sedang dihitung. Muat ulang halaman untuk melihat kemajuannya.'
            : `Run berstatus ${run.status} tidak dapat dihitung ulang. Batalkan dan buat run baru.`,
          ctx.correlationId,
        );
      }

      await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'CALCULATING', lastError: null },
      });

      await publishEvent(ctx.tx, ctx.tenantId, {
        topic: EventTopic.PAYROLL_RUN_REQUESTED,
        payload: { tenantId: ctx.tenantId, runId, actorUserId: ctx.userId },
      });

      // 202, not 200. The calculation has not happened yet, and returning 200
      // with zeroes would read as "a thousand employees, nought rupiah".
      return NextResponse.json(
        {
          runId,
          status: 'CALCULATING',
          message:
            'Perhitungan dijalankan di latar belakang. Muat ulang halaman untuk melihat kemajuannya.',
        },
        { status: 202 },
      );
    }

    if (parsed.data.action === 'approve') {
      if (!ctx.access.permissions.includes(APPROVE)) {
        return apiError(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Persetujuan run membutuhkan izin tersendiri.',
          ctx.correlationId,
        );
      }

      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (run?.status !== 'CALCULATED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          `Hanya run yang sudah dihitung dapat disetujui. Status saat ini: ${run?.status ?? 'tidak ada'}.`,
          ctx.correlationId,
        );
      }

      const approved = await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: ctx.userId },
        select: { id: true, status: true },
      });
      return NextResponse.json(approved);
    }

    if (parsed.data.action === 'markPaid') {
      /**
       * Marks the salaries as genuinely paid out.
       *
       * The `PAID` status and the `paid_at` column have existed since the payroll
       * module was built, and two read paths check them — the dashboard and the
       * payslip list both treat `APPROVED` and `PAID` as "released". But **no path
       * produced them**, the same pattern as `LEAVE`, `MANUAL`, `DISCARDED`, and
       * the tenant statuses.
       *
       * What was missing is more than vocabulary. Approval and payment are two
       * distinct events often days apart: a run approved on the 25th, the bank
       * transfer executed on the 28th. Without that distinction, the question
       * "did last month's salary actually go out" has no answer inside the system
       * — and that question comes from the employee whose money has not arrived.
       *
       * Its permission is the same as approving: whoever may release a run is
       * whoever may state that the money has gone.
       */
      if (!ctx.access.permissions.includes(APPROVE)) {
        return apiError(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Menandai run terbayar membutuhkan izin persetujuan run.',
          ctx.correlationId,
        );
      }

      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (run?.status !== 'APPROVED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          `Hanya run yang sudah disetujui dapat ditandai terbayar. Status saat ini: ${run?.status ?? 'tidak ada'}.`,
          ctx.correlationId,
        );
      }

      const paid = await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'PAID', paidAt: new Date() },
        select: { id: true, status: true, paidAt: true },
      });

      await writeAudit(ctx.tx, ctx.tenantId, {
        action: 'payroll.run.paid',
        entityType: 'payroll_run',
        entityId: runId,
        actorUserId: ctx.userId,
        correlationId: ctx.correlationId,
        after: { paidAt: paid.paidAt, reference: parsed.data.reference ?? null },
      });

      return NextResponse.json(paid);
    }

    // Cancellation. Its payslips are NOT deleted — a cancelled run can still be
    // inspected, and the partial unique index excludes the CANCELLED status so
    // that period reopens for a new run.
    const cancelled = await ctx.tx.payrollRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', lastError: `Dibatalkan: ${parsed.data.reason}` },
      select: { id: true, status: true },
    });
    return NextResponse.json(cancelled);
  } catch (error) {
    if (error instanceof PayrollError) {
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
