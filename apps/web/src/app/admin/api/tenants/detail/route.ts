import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { tenantDetail } from '@hrms/core/platform';
import { defineAdminRoute, adminError } from '@/lib/define-admin-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ tenantId: z.string().uuid() });

/**
 * Satu tenant beserta keadaan seluruh modulnya.
 *
 * Query string, bukan segmen dinamis `[id]`, dan itu bukan selera: manifes
 * control plane mencocokkan `routeId` secara harfiah, dan segmen dinamis di
 * bidang admin akan menuntut bentuk pencocokan kedua yang berbeda dari bidang
 * tenant. Dua mekanisme pencocokan rute untuk satu sistem adalah dua tempat
 * seseorang harus ingat memperbarui.
 */
export const GET = defineAdminRoute('GET /admin/api/tenants/detail', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return adminError(400, ErrorCode.VALIDATION_FAILED, 'tenantId tidak sah', ctx.correlationId);
  }

  const detail = await tenantDetail(parsed.data.tenantId);
  if (!detail) {
    return adminError(404, ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan', ctx.correlationId);
  }

  return NextResponse.json(detail);
});
