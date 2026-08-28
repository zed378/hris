import { NextResponse } from 'next/server';
import { buildDashboard } from '@hrms/core/dashboard';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VIEW_OWN = 'core.dashboard.view.own';
const VIEW_TEAM = 'core.dashboard.view.team';
const VIEW_TENANT = 'core.dashboard.view.tenant';

/**
 * Ringkasan dasbor (dokumen 07 §5).
 *
 * Cakupannya ditentukan IZIN, bukan parameter. Klien tidak dapat meminta
 * cakupan yang lebih luas dari haknya — ia hanya menerima apa yang berhak ia
 * lihat, dan bagian yang tidak berhak datang sebagai `null` alih-alih galat.
 *
 * `null` dipilih dengan sengaja atas nol. Nol adalah angka, dan angka terbaca
 * sebagai fakta: "Presensi ditandai: 0" pada tenant yang belum berlangganan
 * presensi bukan informasi, ia salah paham yang menunggu terjadi.
 */
export const GET = defineRoute('GET /api/dashboard', async (_req, ctx) => {
  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  const summary = await buildDashboard(ctx.tx, ctx.tenantId, {
    employeeId: me?.id ?? null,
    userId: ctx.userId,
    modules: new Set(ctx.access.modules),
    canViewOwn: ctx.access.permissions.includes(VIEW_OWN),
    canViewTeam: ctx.access.permissions.includes(VIEW_TEAM),
    canViewTenant: ctx.access.permissions.includes(VIEW_TENANT),
  });

  return NextResponse.json(summary);
});
