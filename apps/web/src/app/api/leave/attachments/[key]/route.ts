import { ErrorCode } from '@hrms/contracts';
import { readAttachment } from '@hrms/core/leave';
import { writeAudit } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Izin melihat lampiran milik orang lain. */
const READ_ALL = 'leave.request.read.all';

/**
 * Menyajikan lampiran cuti.
 *
 * Surat dokter adalah **data kesehatan** — kategori data pribadi spesifik
 * menurut UU PDP No. 27/2022 Pasal 4 ayat (2), yang perlindungannya lebih ketat
 * daripada data pribadi umum. Karena itu dua hal berlaku di sini yang tidak
 * berlaku pada berkas lain:
 *
 * **Hanya pemiliknya dan pemegang izin membaca cuti orang lain.** Tidak cukup
 * memegang kunci penyimpanan: kunci itu memang acak, tetapi ia pernah lewat di
 * layar dan di log peramban orang lain.
 *
 * **Setiap pembacaan dicatat.** Pertanyaan "siapa saja yang pernah membuka surat
 * dokter saya" harus punya jawaban, dan pada data kesehatan pertanyaan itu wajar
 * ditanyakan.
 */
export const GET = defineRoute('GET /api/leave/attachments/[key]', async (_req, ctx) => {
  const key = ctx.params['key'];
  if (!key) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Kunci tidak ada', ctx.correlationId);
  }

  const found = await readAttachment(ctx.tx, ctx.tenantId, key);
  if (!found) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Lampiran tidak ditemukan', ctx.correlationId);
  }

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  const milikSendiri = me?.id === found.employeeId;
  const bolehSemua = ctx.access.permissions.includes(READ_ALL);

  if (!milikSendiri && !bolehSemua) {
    // 404, bukan 403. Membedakannya memberi tahu pemanggil bahwa kunci itu ada
    // dan milik orang lain — dan pada data kesehatan, keberadaannya sendiri
    // sudah merupakan keterangan.
    return apiError(404, ErrorCode.NOT_FOUND, 'Lampiran tidak ditemukan', ctx.correlationId);
  }

  // Pembacaan milik sendiri tidak dicatat: ia tidak menjawab pertanyaan apa pun,
  // dan mencatatnya akan menenggelamkan pembacaan oleh orang lain — satu-satunya
  // yang benar-benar perlu terlihat.
  if (!milikSendiri) {
    await writeAudit(ctx.tx, ctx.tenantId, {
      action: 'leave.attachment.read',
      entityType: 'leave_attachment',
      entityId: found.view.id,
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
      after: { employeeId: found.employeeId, fileName: found.view.fileName },
    });
  }

  return new Response(new Uint8Array(found.content), {
    headers: {
      'content-type': found.view.mimeType,
      // `inline`, bukan `attachment`: penyetuju perlu MELIHAT surat dokternya
      // untuk memutuskan, bukan mengunduhnya ke laptopnya.
      'content-disposition': `inline; filename="${found.view.fileName.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
      // Berkas dikirim pengguna. Tanpa header ini, peramban dapat menebak
      // jenisnya sendiri dan menjalankan yang seharusnya sekadar ditampilkan.
      'x-content-type-options': 'nosniff',
    },
  });
});
