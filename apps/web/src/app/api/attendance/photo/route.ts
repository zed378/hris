import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { storePhoto, PhotoError, MAX_PHOTO_BYTES } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mengunggah foto presensi.
 *
 * Diunggah lewat server, bukan presigned URL langsung ke object storage. Untuk
 * berkas 100 KB dengan volume satu per ketukan, proxy lewat server jauh lebih
 * sederhana — dan yang lebih penting: ia satu-satunya cara memastikan EXIF
 * benar-benar terhapus sebelum berkas menyentuh penyimpanan.
 *
 * Presigned URL menyerahkan berkas apa adanya dari perangkat, lengkap dengan
 * koordinat GPS di dalamnya (dokumen 10 §4.3).
 */
export const POST = defineRoute('POST /api/attendance/photo', async (req, ctx) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get('photo');

  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Sertakan berkas foto', ctx.correlationId);
  }

  if (file.size > MAX_PHOTO_BYTES) {
    return apiError(
      413,
      ErrorCode.VALIDATION_FAILED,
      `Foto terlalu besar. Maksimal ${MAX_PHOTO_BYTES / 1024} KB.`,
      ctx.correlationId,
    );
  }

  try {
    const stored = await storePhoto(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(stored, { status: 201 });
  } catch (error) {
    if (error instanceof PhotoError) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
