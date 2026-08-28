import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { buildLeaveExport } from '@hrms/core/reporting';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { xlsxResponse } from '@/lib/xlsx.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'TAKEN']).optional(),
});

/** Rekap pengajuan cuti satu tahun sebagai .xlsx. */
export const GET = defineRoute('GET /api/leave/requests/export', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Sebutkan tahun', ctx.correlationId);
  }

  const result = await buildLeaveExport(
    ctx.tx,
    ctx.tenantId,
    { year: parsed.data.year, status: parsed.data.status },
    {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    },
  );

  return xlsxResponse(result, {
    sheet: 'Rekap Cuti',
    fileName: `cuti-${parsed.data.year}.xlsx`,
    columnWidths: [18, 16, 24, 18, 12, 12, 12, 12, 40, 20, 14, 40],
  });
});
