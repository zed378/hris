import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { setTenantStatus, TenantStatusError } from '@hrms/core/platform';
import { defineAdminRoute, adminError } from '@/lib/define-admin-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  tenantId: z.string().uuid(),
  status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CHURNED']),
  /**
   * Alasan wajib, dan panjangnya diperiksa.
   *
   * Penangguhan tanpa alasan tidak dapat dijelaskan kepada pelanggan yang
   * menelepon esok paginya, dan "menonaktifkan seluruh akses satu perusahaan"
   * adalah tindakan yang harus meninggalkan kalimat, bukan hanya stempel waktu.
   */
  reason: z.string().trim().min(8).max(500),
});

/**
 * Menangguhkan, mengaktifkan kembali, atau mengakhiri satu tenant.
 *
 * `SUSPENDED` dan `CHURNED` sudah diperiksa sejak awal pada login, refresh, dan
 * reset kata sandi — tetapi tidak ada satu pun jalur yang menghasilkannya.
 * Akibatnya pelanggan yang berhenti membayar tidak dapat dinonaktifkan, dan
 * pelanggan yang meminta pengakhiran layanan hanya dapat dilayani dengan
 * menghapus data.
 *
 * Penangguhan **tidak menghapus apa pun**: pelanggan yang membayar tunggakannya
 * pada hari ketiga menemukan seluruh datanya utuh, dan yang tidak kembali tetap
 * berhak atas ekspor portabilitasnya.
 */
export const POST = defineAdminRoute('POST /admin/api/tenants/status', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return adminError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data tidak sah. Alasan wajib diisi, minimal 8 karakter.',
      ctx.correlationId,
    );
  }

  try {
    const result = await setTenantStatus({
      ...parsed.data,
      actorSuperuserId: ctx.superuser.sub,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TenantStatusError) {
      return adminError(409, ErrorCode.CONFLICT, error.message, ctx.correlationId);
    }
    throw error;
  }
});
