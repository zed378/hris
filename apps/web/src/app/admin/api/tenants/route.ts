import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { listTenants, setTenantModule, ModuleToggleError } from '@hrms/core/platform';
import { defineAdminRoute, adminError } from '@/lib/define-admin-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineAdminRoute('GET /admin/api/tenants', async (req) => {
  const url = new URL(req.url);
  const result = await listTenants({
    limit: Number(url.searchParams.get('limit') ?? 50),
    offset: Number(url.searchParams.get('offset') ?? 0),
    ...(url.searchParams.get('status') ? { status: url.searchParams.get('status')! } : {}),
  });
  return NextResponse.json(result);
});

const toggleSchema = z.object({
  tenantId: z.string().uuid(),
  moduleCode: z.string().min(1).max(64),
  enabled: z.boolean(),
});

/**
 * Mengaktifkan atau menonaktifkan modul untuk satu tenant.
 *
 * Ini satu-satunya jalur di control plane yang **menulis** ke bidang tenant, dan
 * ia dibatasi pada satu tabel oleh hak akses `hrms_platform`. Perhatikan bahwa
 * data modul tidak dihapus saat dinonaktifkan — statusnya berubah, menunya
 * hilang, endpoint-nya menolak 402, dan seluruh isinya kembali utuh saat
 * diaktifkan lagi.
 */
export const POST = defineAdminRoute('POST /admin/api/tenants', async (req, ctx) => {
  const parsed = toggleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return adminError(400, ErrorCode.VALIDATION_FAILED, 'Data tidak sah', ctx.correlationId);
  }

  try {
    const result = await setTenantModule({
      ...parsed.data,
      actorSuperuserId: ctx.superuser.sub,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ModuleToggleError) {
      return adminError(409, ErrorCode.CONFLICT, error.message, ctx.correlationId);
    }
    throw error;
  }
});
