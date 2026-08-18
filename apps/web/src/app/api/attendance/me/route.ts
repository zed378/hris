import { NextResponse } from 'next/server';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { ErrorCode } from '@hrms/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Presensi milik sendiri, beserta seluruh buktinya.
 *
 * Dokumen 10 §8.2 mensyaratkan karyawan dapat melihat seluruh bukti presensi
 * dirinya sendiri — termasuk koordinat, jarak, dan skor kepercayaannya. Sistem
 * yang menilai orang tanpa menunjukkan dasar penilaiannya adalah sistem yang
 * tidak dapat dibantah.
 */
export const GET = defineRoute('GET /api/attendance/me', async (req, ctx) => {
  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  if (!me) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Akun belum terhubung ke data karyawan', ctx.correlationId);
  }

  const url = new URL(req.url);
  const days = Math.min(Number(url.searchParams.get('days') ?? 30), 92);
  const since = new Date(Date.now() - days * 86_400_000);

  const [punches, summary] = await Promise.all([
    ctx.tx.punchLog.findMany({
      where: { tenantId: ctx.tenantId, employeeId: me.id, punchedAt: { gte: since } },
      orderBy: { punchedAt: 'desc' },
      take: 200,
      select: {
        id: true, type: true, source: true, punchedAt: true, workDate: true,
        distanceM: true, accuracyM: true, trustScore: true, trustFlags: true,
        review: true, photoKey: true,
        workSite: { select: { name: true } },
      },
    }),
    ctx.tx.attendanceDay.findMany({
      where: { tenantId: ctx.tenantId, employeeId: me.id, workDate: { gte: since } },
      orderBy: { workDate: 'desc' },
      select: {
        workDate: true, status: true, checkIn: true, checkOut: true,
        lateMinutes: true, workMinutes: true, overtimeMinutes: true,
      },
    }),
  ]);

  return NextResponse.json({
    punches: punches.map((p) => ({
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
      review: p.review,
      hasPhoto: Boolean(p.photoKey),
    })),
    days: summary.map((d) => ({
      workDate: d.workDate.toISOString().slice(0, 10),
      status: d.status,
      checkIn: d.checkIn?.toISOString() ?? null,
      checkOut: d.checkOut?.toISOString() ?? null,
      lateMinutes: d.lateMinutes,
      workMinutes: d.workMinutes,
      overtimeMinutes: d.overtimeMinutes,
    })),
  });
});
