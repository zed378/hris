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
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Employee ID is required', ctx.correlationId);
  }

  const includeArchived = new URL(req.url).searchParams.get('archived') === 'true';

  return NextResponse.json({
    documents: await listDocuments(ctx.tx, ctx.tenantId, employeeId, { includeArchived }),
  });
});

/**
 * Uploads an employee document.
 *
 * The file type is determined from the file CONTENTS, not from its `content-type`
 * nor the extension of its name — both are sent by the client and both can lie.
 * The check lives in `sniffType` in the core layer; here only the request shape is
 * validated.
 */
export const POST = defineRoute('POST /api/employees/[id]/documents', async (req, ctx) => {
  const employeeId = ctx.params['id'];
  if (!employeeId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Employee ID is required', ctx.correlationId);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Request must be multipart/form-data.', ctx.correlationId);
  }

  const file = form.get('file');
  const kind = String(form.get('kind') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const expiresRaw = String(form.get('expiresAt') ?? '').trim();

  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'File not found.', ctx.correlationId);
  }
  if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `Unrecognized document type. Choose one: ${DOCUMENT_KINDS.join(', ')}.`,
      ctx.correlationId,
    );
  }
  if (title.length < 2) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Document title is required, at least 2 characters.',
      ctx.correlationId,
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `File size exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit.`,
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
