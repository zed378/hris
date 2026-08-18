import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { commitImport, ImportError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Menyimpan baris yang sah dari sebuah pratinjau.
 *
 * Idempoten lewat status pekerjaan: pratinjau yang sudah disimpan menolak
 * penyimpanan kedua dengan 409. Tanpa itu, klik ganda pada tombol "Simpan" —
 * hal paling wajar yang dilakukan orang saat halaman terasa lambat — akan
 * menggandakan seluruh karyawan.
 */
export const POST = defineRoute('POST /api/employees/import/[id]/commit', async (_req, ctx) => {
  const id = ctx.params['id'];
  if (!id) return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id tidak ada', ctx.correlationId);

  try {
    return NextResponse.json(
      await commitImport(ctx.tx, ctx.tenantId, id, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      }),
    );
  } catch (error) {
    if (error instanceof ImportError) {
      const status = error.kind === 'not_found' ? 404 : 409;
      const code = error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT;
      return apiError(status, code, error.message, ctx.correlationId);
    }
    throw error;
  }
});
