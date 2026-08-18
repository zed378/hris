import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { parseImportFile, ImportError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Batas ukuran berkas.
 *
 * 10.000 baris karyawan dengan seluruh kolom berada di sekitar 2–3 MB. Batas 10 MB
 * memberi ruang untuk berkas yang membawa pemformatan berat — dan berkas Excel
 * milik HR hampir selalu membawanya.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Unggah berkas impor. Menghasilkan pratinjau, tidak menyimpan satu karyawan pun.
 *
 * Perhatikan bahwa seluruh pekerjaan berjalan di dalam transaksi request. Itu
 * pilihan sadar untuk ukuran ini: 10.000 baris terurai dan tervalidasi dalam
 * hitungan detik, dan memindahkannya ke worker berarti klien harus menanyakan
 * status berulang kali untuk sesuatu yang sudah selesai sebelum polling pertama.
 *
 * Pemicu untuk memindahkannya ke worker sudah jelas dan terukur: bila `MAX_ROWS`
 * dinaikkan melewati 10.000, atau bila p95 endpoint ini melewati 10 detik.
 */
export const POST = defineRoute('POST /api/employees/import', async (req, ctx) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');

  if (!(file instanceof File)) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sertakan berkas .xlsx pada field "file"',
      ctx.correlationId,
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return apiError(
      413,
      ErrorCode.VALIDATION_FAILED,
      `Ukuran berkas ${(file.size / 1024 / 1024).toFixed(1)} MB melewati batas 10 MB`,
      ctx.correlationId,
    );
  }

  try {
    const preview = await parseImportFile(
      ctx.tx,
      ctx.tenantId,
      { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) },
      {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
    );
    return NextResponse.json(preview, { status: 201 });
  } catch (error) {
    if (error instanceof ImportError) {
      const status = error.kind === 'too_large' ? 413 : 400;
      return apiError(status, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
