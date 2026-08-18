import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { reviewPunch, PunchError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Antrean tinjauan presensi bertanda.
 *
 * Metrik yang harus dipantau: bila lebih dari 12% presensi masuk antrean ini,
 * HR berhenti meninjau dan skor kepercayaan berubah menjadi teater
 * (PLAN/12 §11). Angka itu dikembalikan bersama daftarnya.
 */
export const GET = defineRoute('GET /api/attendance/review', async (_req, ctx) => {
  const [flagged, total] = await Promise.all([
    ctx.tx.punchLog.findMany({
      where: { tenantId: ctx.tenantId, review: 'NEEDS_REVIEW' },
      orderBy: { punchedAt: 'desc' },
      take: 100,
      select: {
        id: true, type: true, source: true, punchedAt: true, workDate: true,
        distanceM: true, accuracyM: true, trustScore: true, trustFlags: true,
        photoKey: true, employeeId: true,
        workSite: { select: { name: true } },
      },
    }),
    ctx.tx.punchLog.count({ where: { tenantId: ctx.tenantId } }),
  ]);

  const employees = await ctx.tx.employee.findMany({
    where: { tenantId: ctx.tenantId, id: { in: flagged.map((p) => p.employeeId) } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const pending = await ctx.tx.punchLog.count({
    where: { tenantId: ctx.tenantId, review: 'NEEDS_REVIEW' },
  });

  return NextResponse.json({
    punches: flagged.map((p) => ({
      id: p.id,
      type: p.type,
      source: p.source,
      punchedAt: p.punchedAt.toISOString(),
      workDate: p.workDate.toISOString().slice(0, 10),
      site: p.workSite?.name ?? null,
      distanceM: p.distanceM,
      accuracyM: p.accuracyM,
      trustScore: p.trustScore,
      flags: p.trustFlags ?? [],
      hasPhoto: Boolean(p.photoKey),
      employee: byId.get(p.employeeId) ?? null,
    })),
    stats: {
      pending,
      total,
      // Rasio inilah yang memberi tahu apakah ambang kepercayaan disetel terlalu
      // ketat. Ditampilkan supaya tidak perlu ada yang menghitungnya manual.
      flaggedRatio: total > 0 ? Number((pending / total).toFixed(4)) : 0,
    },
  });
});

const decisionSchema = z.object({
  punchId: z.string().uuid(),
  approve: z.boolean(),
  reason: z.string().trim().min(4).max(500),
});

export const POST = defineRoute('POST /api/attendance/review', async (req, ctx) => {
  const parsed = decisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Keputusan tinjauan wajib menyertakan alasan minimal 4 karakter',
      ctx.correlationId,
    );
  }

  try {
    await reviewPunch(
      ctx.tx,
      ctx.tenantId,
      { punchId: parsed.data.punchId, approve: parsed.data.approve, note: parsed.data.reason },
      ctx.userId,
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof PunchError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
