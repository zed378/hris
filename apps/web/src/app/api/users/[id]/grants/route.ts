import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { setUserGrant, removeUserGrant, IamError } from '@hrms/core/iam';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const putSchema = z.object({
  permissionCode: z.string().min(3).max(128),
  effect: z.enum(['GRANT', 'DENY']),
  // Minimal 8 karakter, sama dengan constraint basis datanya. Divalidasi di dua
  // tempat dengan sengaja: yang di sini memberi pesan galat yang berguna, yang
  // di basis data memastikan tidak ada jalur lain yang bisa melewatinya.
  reason: z.string().trim().min(8).max(500),
  expiresAt: z.coerce.date().optional(),
});

const deleteSchema = z.object({ permissionCode: z.string().min(3).max(128) });

/**
 * Memberi atau mencabut satu permission untuk satu pengguna, di luar perannya
 * (PLAN/05 §4).
 *
 * `DENY` selalu menang atas peran maupun atas `GRANT`. Itulah yang membuat
 * pencabutan darurat dapat diandalkan: tidak perlu menelusuri seluruh peran
 * seseorang untuk memastikan sebuah izin benar-benar hilang.
 *
 * Versi akses naik di transaksi yang sama, sehingga izin yang dicabut berhenti
 * berlaku seketika — bukan setelah TTL cache habis.
 */
export const PUT = defineRoute('PUT /api/users/[id]/grants', async (req, ctx) => {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data hak akses tidak sah. Alasan wajib diisi minimal 8 karakter.',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const userId = ctx.params['id'];
  if (!userId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id pengguna tidak ada', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await setUserGrant(
        ctx.tx,
        ctx.tenantId,
        { userId, ...parsed.data },
        {
          actorUserId: ctx.userId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          correlationId: ctx.correlationId,
        },
      ),
    );
  } catch (error) {
    if (error instanceof IamError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});

export const DELETE = defineRoute('DELETE /api/users/[id]/grants', async (req, ctx) => {
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  const userId = ctx.params['id'];
  if (!parsed.success || !userId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data tidak sah', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await removeUserGrant(
        ctx.tx,
        ctx.tenantId,
        { userId, permissionCode: parsed.data.permissionCode },
        {
          actorUserId: ctx.userId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          correlationId: ctx.correlationId,
        },
      ),
    );
  } catch (error) {
    if (error instanceof IamError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
