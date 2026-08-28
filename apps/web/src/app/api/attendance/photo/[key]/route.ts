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
    select: { id: true, employeeId: true },
  });

  if (!punch) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Foto tidak ditemukan', ctx.correlationId);
  }

  const canReviewAll = ctx.access.permissions.includes('attendance.review.handle');
  let isOwner = false;

  if (!canReviewAll) {
    const me = await ctx.tx.employee.findFirst({
      where: { tenantId: ctx.tenantId, email: ctx.email },
      select: { id: true },
    });
    if (!me || me.id !== punch.employeeId) {
      return apiError(403, ErrorCode.PERMISSION_DENIED, 'Bukan foto Anda', ctx.correlationId);
    }
    isOwner = true;
  }

  /**
   * Aturan PR6: akses HR ke foto presensi dicatat.
   *
   * Dicatat SEBELUM berkasnya dibaca, bukan sesudah. Percobaan akses yang gagal
   * karena berkasnya sudah kedaluwarsa tetap merupakan percobaan akses, dan
   * mencatatnya hanya setelah berhasil akan membuat jejaknya bergantung pada
   * apakah retensi sudah berjalan.
   *
   * Karyawan yang melihat fotonya sendiri tidak dicatat. Yang hendak dijawab
   * tabel ini adalah "siapa lagi yang pernah melihat foto saya", dan mengisinya
   * dengan kunjungan pemiliknya sendiri hanya membuat jawabannya sulit dibaca.
   */
  if (!isOwner) {
    await ctx.tx.photoAccessLog.create({
      data: {
        tenantId: ctx.tenantId,
        punchId: punch.id,
        employeeId: punch.employeeId,
        accessedBy: ctx.userId,
        action: 'VIEW',
      },
    });
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
