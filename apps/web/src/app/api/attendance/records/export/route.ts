import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { buildAttendanceExport } from '@hrms/core/reporting';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { xlsxResponse } from '@/lib/xlsx.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: z.string().uuid().optional(),
});

/**
 * Rekap presensi sebagai .xlsx.
 *
 * Rentangnya WAJIB disebut, tidak ada bawaan "semua". Rekap presensi tanpa batas
 * tanggal adalah seluruh riwayat kehadiran setiap orang di perusahaan — berkas
 * yang tidak dibutuhkan siapa pun dan tidak seharusnya beredar.
 */
export const GET = defineRoute('GET /api/attendance/records/export', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sebutkan rentang tanggal: from=YYYY-MM-DD&to=YYYY-MM-DD',
      ctx.correlationId,
    );
  }

  const result = await buildAttendanceExport(
    ctx.tx,
    ctx.tenantId,
    {
      from: new Date(`${parsed.data.from}T00:00:00.000Z`),
      to: new Date(`${parsed.data.to}T00:00:00.000Z`),
      employeeId: parsed.data.employeeId,
    },
    {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    },
  );

  return xlsxResponse(result, {
    sheet: 'Rekap Presensi',
    fileName: `presensi-${parsed.data.from}-sd-${parsed.data.to}.xlsx`,
    columnWidths: [12, 16, 24, 12, 10, 10, 16, 16, 12, 14, 10],
  });
});
