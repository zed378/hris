import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { uploadAttachment, LeaveError, MAX_ATTACHMENT_BYTES } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mengunggah lampiran pengajuan cuti — surat dokter, surat keterangan.
 *
 * Diunggah **atas nama diri sendiri**: karyawan diturunkan dari sesi, bukan dari
 * badan permintaan. Menerima `employeeId` dari klien di sini berarti siapa pun
 * dapat menempelkan berkas ke berkas cuti orang lain.
 *
 * Unggah mendahului pengajuan, karena pengunggahnya belum tahu id pengajuannya.
 * Lampiran karenanya lahir yatim dan diadopsi saat pengajuan dibuat; yang tetap
 * yatim dibersihkan job harian.
 */
export const POST = defineRoute('POST /api/leave/attachments', async (req, ctx) => {
  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });
  if (!me) {
    return apiError(
      404,
      ErrorCode.NOT_FOUND,
      'Akun Anda belum terhubung ke data karyawan. Hubungi admin HR.',
      ctx.correlationId,
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');

  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Berkas tidak ada', ctx.correlationId);
  }

  // Diperiksa sebelum dibaca ke memori. Membaca dulu lalu menolak berarti
  // sebuah berkas 500 MB tetap sempat masuk memori proses.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return apiError(
      413,
      ErrorCode.VALIDATION_FAILED,
      `Ukuran berkas melebihi batas ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      ctx.correlationId,
    );
  }

  try {
    const result = await uploadAttachment(
      ctx.tx,
      ctx.tenantId,
      {
        employeeId: me.id,
        fileName: file.name,
        content: Buffer.from(await file.arrayBuffer()),
      },
      ctx.userId,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof LeaveError) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
