import { NextResponse } from 'next/server';
import type { BootstrapResponse } from '@hrms/contracts';
import { buildMenuTree } from '@hrms/core/iam';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Satu-satunya sumber yang dipakai frontend untuk merender sidebar dan menjaga
 * rute (PLAN/01 §5.4).
 *
 * Perlu ditegaskan apa yang bukan perannya: ini bukan otorisasi. Setiap kontrol
 * UI yang digambar dari balasan ini punya pasangannya di `ROUTE_MANIFEST`, dan
 * bila keduanya berbeda, manifest yang berlaku (P9).
 */
export const GET = defineRoute('GET /api/me/bootstrap', async (_req, ctx) => {
  const [user, tenant, menu] = await Promise.all([
    ctx.tx.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { id: true, email: true, fullName: true },
    }),
    ctx.tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { id: true, code: true, name: true, status: true, planCode: true, trialEndsAt: true },
    }),
    buildMenuTree(ctx.tx, ctx.access),
  ]);

  const body: BootstrapResponse = {
    user,
    tenant: { ...tenant, trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null },
    modules: ctx.access.modules,
    permissions: ctx.access.permissions,
    menu,
    accessVersion: ctx.access.accessVersion,
  };

  return NextResponse.json(body);
});
