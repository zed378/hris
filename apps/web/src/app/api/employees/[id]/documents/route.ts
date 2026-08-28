import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import {
  listDocuments,
  uploadDocument,
  DocumentError,
  DOCUMENT_KINDS,
  MAX_DOCUMENT_BYTES,
  type DocumentKind,
} from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/employees/[id]/documents', async (req, ctx) => {
  const employeeId = ctx.params['id'];
  if (!employeeId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id karyawan tidak ada', ctx.correlationId);
  }

  const includeArchived = new URL(req.url).searchParams.get('archived') === 'true';

  return NextResponse.json({
    documents: await listDocuments(ctx.tx, ctx.tenantId, employeeId, { includeArchived }),
  });
});

/**
 * Mengunggah dokumen karyawan.
 *
 * Jenis berkas ditentukan dari ISI berkasnya, bukan dari `content-type` maupun
 * ekstensi namanya — keduanya dikirim klien dan keduanya dapat berbohong.
 * Pemeriksaannya ada di `sniffType` pada lapisan core; di sini hanya bentuk
 * permintaannya yang divalidasi.
 */
export const POST = defineRoute('POST /api/employees/[id]/documents', async (req, ctx) => {
  const employeeId = ctx.params['id'];
  if (!employeeId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id karyawan tidak ada', ctx.correlationId);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Permintaan harus berupa multipart/form-data.',
      ctx.correlationId,
    );
  }

  const file = form.get('file');
  const kind = String(form.get('kind') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const expiresRaw = String(form.get('expiresAt') ?? '').trim();

  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Berkas tidak ditemukan.', ctx.correlationId);
  }
  if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `Jenis dokumen tidak dikenali. Pilih salah satu: ${DOCUMENT_KINDS.join(', ')}.`,
      ctx.correlationId,
    );
  }
  if (title.length < 2) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Judul dokumen wajib diisi, minimal 2 karakter.',
      ctx.correlationId,
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `Ukuran berkas melebihi batas ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
      ctx.correlationId,
    );
  }

  // Tanggal kedaluwarsa yang tidak dapat dibaca diperlakukan sebagai tidak ada,
  // bukan sebagai galat: kolomnya memang opsional, dan menolak seluruh unggahan
  // karena satu isian opsional salah format akan membuat orang mengunggah ulang
  // berkas 8 MB tanpa alasan yang jelas.
  const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
  const validExpiry = expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null;

  try {
    const document = await uploadDocument(
      ctx.tx,
      ctx.tenantId,
      {
        employeeId,
        kind: kind as DocumentKind,
        title,
        fileName: file.name,
        content: Buffer.from(await file.arrayBuffer()),
        expiresAt: validExpiry,
      },
      ctx.userId,
      ctx.ip ?? null,
    );
    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentError) {
      return apiError(
        error.kind === 'not_found' ? 404 : 400,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
