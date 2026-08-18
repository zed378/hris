import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { getImportPreview, ImportError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/employees/import/[id]', async (req, ctx) => {
  const id = ctx.params['id'];
  if (!id) return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id tidak ada', ctx.correlationId);

  const url = new URL(req.url);
  try {
    return NextResponse.json(
      await getImportPreview(ctx.tx, ctx.tenantId, id, {
        // Default menampilkan baris bergalat saja: itu yang perlu ditindaklanjuti.
        // Baris yang sah tidak menuntut perhatian siapa pun.
        onlyErrors: url.searchParams.get('all') !== 'true',
        limit: Number(url.searchParams.get('limit') ?? 100),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }),
    );
  } catch (error) {
    if (error instanceof ImportError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
