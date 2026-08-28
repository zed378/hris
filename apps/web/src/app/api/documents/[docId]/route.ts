import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { readDocument, archiveDocument, DocumentError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READ_ALL = 'employee.document.read';
const MANAGE = 'employee.document.manage';

/**
 * Menyajikan isi dokumen karyawan.
 *
 * Otorisasi berlapis, dan lapisan kedua yang menanggung beban: pemegang
 * `employee.document.read` boleh membuka dokumen siapa pun, sedangkan karyawan
 * biasa hanya dokumennya sendiri. Izin pada manifes sengaja izin dasar yang
 * dimiliki semua orang — tanpa itu, karyawan tidak dapat melihat pindaian KTP-nya
 * sendiri, yang justru hak yang dijamin UU PDP.
 *
 * Setiap penyajian ditandai `no-store`: dokumen identitas tidak boleh tertinggal
 * di cache peramban perangkat bersama.
 */
export const GET = defineRoute('GET /api/documents/[docId]', async (_req, ctx) => {
  const documentId = ctx.params['docId'];
  if (!documentId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id dokumen tidak ada', ctx.correlationId);
  }

  const canReadAll = ctx.access.permissions.includes(READ_ALL);

  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  try {
    // Kepemilikan diperiksa terhadap baris dokumennya, sehingga id dokumen milik
    // orang lain tidak dapat dipakai hanya karena penebaknya punya baris karyawan.
    const peek = await ctx.tx.employeeDocument.findFirst({
      where: { id: documentId, tenantId: ctx.tenantId },
      select: { employeeId: true },
    });
    if (!peek) {
      return apiError(404, ErrorCode.NOT_FOUND, 'Dokumen tidak ditemukan', ctx.correlationId);
    }

    const isOwner = Boolean(me && me.id === peek.employeeId);
    if (!canReadAll && !isOwner) {
      return apiError(
        403,
        ErrorCode.PERMISSION_DENIED,
        'Bukan dokumen Anda',
        ctx.correlationId,
      );
    }

    const { content, document } = await readDocument(ctx.tx, ctx.tenantId, documentId, {
      userId: ctx.userId,
      isOwner,
    });

    return new Response(new Uint8Array(content), {
      headers: {
        'content-type': document.mimeType,
        'cache-control': 'no-store, private',
        // `inline` untuk PDF dan gambar supaya dapat dilihat tanpa mengunduh —
        // berkas yang terunduh ke folder Downloads perangkat bersama bertahan
        // jauh lebih lama daripada tab yang ditutup.
        'content-disposition': `inline; filename="${encodeURIComponent(document.fileName)}"`,
      },
    });
  } catch (error) {
    if (error instanceof DocumentError) {
      return apiError(
        error.kind === 'archived' ? 410 : 404,
        ErrorCode.NOT_FOUND,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});

/**
 * Mengarsipkan dokumen.
 *
 * DELETE pada HTTP, pengarsipan pada basis data. Berkas fisiknya memang dibuang
 * — ia data pribadi yang tidak lagi diperlukan — tetapi barisnya bertahan
 * (aturan M4 dokumen 09), sehingga "siapa mengunggah pindaian KTP ini dan kapan
 * dibuang" tetap punya jawaban.
 */
export const DELETE = defineRoute('DELETE /api/documents/[docId]', async (_req, ctx) => {
  const documentId = ctx.params['docId'];
  if (!documentId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id dokumen tidak ada', ctx.correlationId);
  }
  if (!ctx.access.permissions.includes(MANAGE)) {
    return apiError(403, ErrorCode.PERMISSION_DENIED, 'Tidak berizin', ctx.correlationId);
  }

  try {
    await archiveDocument(ctx.tx, ctx.tenantId, documentId, ctx.userId, ctx.ip ?? null);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof DocumentError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
