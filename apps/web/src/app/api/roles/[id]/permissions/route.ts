import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { setRolePermissions, IamError } from '@hrms/core/iam';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ permissions: z.array(z.string().min(3).max(128)).max(500) });

/**
 * Mengganti seluruh permission sebuah peran sekaligus.
 *
 * PUT, bukan PATCH — matriks peran × permission adalah layar yang disimpan
 * utuh, dan bentuk API-nya mengikuti bentuk layarnya. Dua permintaan terpisah
 * untuk menambah dan menghapus akan meninggalkan keadaan setengah tersimpan
 * bila yang kedua gagal.
 */
export const PUT = defineRoute('PUT /api/roles/[id]/permissions', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Daftar permission tidak sah', ctx.correlationId);
  }

  const roleId = ctx.params['id'];
  if (!roleId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id peran tidak ada', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await setRolePermissions(ctx.tx, ctx.tenantId, roleId, parsed.data.permissions, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      }),
    );
  } catch (error) {
    if (error instanceof IamError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
