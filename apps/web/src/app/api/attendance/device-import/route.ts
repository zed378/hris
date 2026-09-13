import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { importDevicePunches, DeviceImportError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One month of punches for 500 employees as CSV ≈ 2 MB. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Importing punches from an attendance machine export file.
 *
 * A single endpoint with two modes, not two endpoints. `commit=false` parses
 * and counts without writing anything; `commit=true` writes. The file is uploaded
 * twice, deliberately: saving a preview on the server means storing raw
 * attendance data in a half-finished state, with its own lifetime and access
 * controls to think through.
 *
 * Parsing is deterministic and writing is idempotent, so parsing twice yields
 * the same result and sending twice duplicates nothing.
 */
export const POST = defineRoute('POST /api/attendance/device-import', async (req, ctx) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Request must be multipart/form-data containing a file.',
      ctx.correlationId,
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'File not found.', ctx.correlationId);
  }
  if (file.size > MAX_FILE_BYTES) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `File size ${Math.round(file.size / 1024 / 1024)} MB exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`,
      ctx.correlationId,
    );
  }

  // Does NOT write by default. A missing or mistyped value produces a
  // preview, not an import — the correct failure mode for an operation that
  // touches the payroll calculation.
  const commit = form.get('commit') === 'true';

  try {
    const result = await importDevicePunches(
      ctx.tx,
      ctx.tenantId,
      { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) },
      ctx.userId,
      { commit },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeviceImportError) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
