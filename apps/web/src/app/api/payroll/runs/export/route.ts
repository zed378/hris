import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { buildPayrollExport } from '@hrms/core/reporting';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { xlsxResponse } from '@/lib/xlsx.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNMASK = 'employee.pii.unmask';

const schema = z.object({ runId: z.string().uuid() });

/**
 * Rekap gaji satu run sebagai .xlsx — bahan unggahan transfer massal bank.
 *
 * Nomor rekening keluar tersamar bagi yang tidak berizin membukanya. Rekap gaji
 * adalah berkas yang paling ingin dibuka orang, dan nomor rekening di dalamnya
 * adalah alasan utamanya — justru karena itu izinnya diperiksa persis seperti
 * pada ekspor karyawan, bukan diasumsikan dari "berkas ini untuk keuangan".
 */
export const GET = defineRoute('GET /api/payroll/runs/export', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Sebutkan runId', ctx.correlationId);
  }

  let result;
  try {
    result = await buildPayrollExport(
      ctx.tx,
      ctx.tenantId,
      {
        runId: parsed.data.runId,
        canUnmask: ctx.access.permissions.includes(UNMASK),
      },
      {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
    );
  } catch {
    return apiError(404, ErrorCode.NOT_FOUND, 'Run tidak ditemukan', ctx.correlationId);
  }

  return xlsxResponse(result, {
    sheet: 'Rekap Gaji',
    fileName: `gaji-${result.runNumber.replace(/\//g, '-')}.xlsx`,
    columnWidths: [16, 24, 16, 22, 24, 16, 16, 16],
  });
});
