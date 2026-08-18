import { ErrorCode } from '@hrms/contracts';
import { readPhoto, PhotoError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Menyajikan foto presensi.
 *
 * Otorisasi berlapis, dan lapisan kedua yang menanggung beban: pemegang
 * `attendance.review.handle` boleh melihat foto siapa pun, sedangkan karyawan
 * biasa hanya fotonya sendiri. Tanpa pemeriksaan kedua itu, siapa pun yang
 * memiliki izin presensi dasar dapat mengambil foto rekan kerjanya hanya dengan
 * menyalin URL.
 *
 * Setiap pembacaan foto ditandai `no-store`: foto presensi tidak boleh
 * tertinggal di cache peramban perangkat bersama (dokumen 11 §5.4).
 */
export const GET = defineRoute('GET /api/attendance/photo/[key]', async (_req, ctx) => {
  const key = ctx.params['key'];
  if (!key) return apiError(400, ErrorCode.VALIDATION_FAILED, 'Kunci tidak ada', ctx.correlationId);

  const punch = await ctx.tx.punchLog.findFirst({
    where: { tenantId: ctx.tenantId, photoKey: key },
    select: { employeeId: true },
  });

  if (!punch) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Foto tidak ditemukan', ctx.correlationId);
  }

  const canReviewAll = ctx.access.permissions.includes('attendance.review.handle');

  if (!canReviewAll) {
    const me = await ctx.tx.employee.findFirst({
      where: { tenantId: ctx.tenantId, email: ctx.email },
      select: { id: true },
    });
    if (!me || me.id !== punch.employeeId) {
      return apiError(403, ErrorCode.PERMISSION_DENIED, 'Bukan foto Anda', ctx.correlationId);
    }
  }

  try {
    const photo = await readPhoto(key);
    return new Response(new Uint8Array(photo), {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store, private',
        'content-disposition': 'inline',
      },
    });
  } catch (error) {
    if (error instanceof PhotoError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
