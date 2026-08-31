import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { buildMonthlyAttendance, monthlyAttendanceRows } from '@hrms/core/reporting';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { xlsxResponse } from '@/lib/xlsx.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  /** `xlsx` mengunduh berkas; selain itu JSON untuk layar. */
  format: z.enum(['json', 'xlsx']).default('json'),
});

/**
 * Rekap presensi bulanan — satu baris per karyawan.
 *
 * Laporan yang dicetak, ditandatangani, dan diarsipkan setiap bulan, dan yang
 * dipakai keuangan memeriksa potongan sebelum payroll dijalankan.
 *
 * Satu endpoint untuk layar dan untuk unduhan, dibedakan `format`. Dua endpoint
 * yang menghitung hal yang sama adalah dua tempat yang dapat berbeda hasilnya —
 * dan perbedaan antara angka di layar dan angka di berkas yang ditandatangani
 * adalah perbedaan yang paling mahal untuk ditemukan.
 */
export const GET = defineRoute('GET /api/reports/attendance-monthly', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sebutkan tahun dan bulan: year=YYYY&month=1..12',
      ctx.correlationId,
    );
  }

  const report = await buildMonthlyAttendance(
    ctx.tx,
    ctx.tenantId,
    parsed.data.year,
    parsed.data.month,
    { actorUserId: ctx.userId, correlationId: ctx.correlationId },
  );

  if (parsed.data.format === 'xlsx') {
    const bulan = String(parsed.data.month).padStart(2, '0');
    return xlsxResponse(
      {
        rows: monthlyAttendanceRows(report),
        rowCount: report.rows.length,
        // Laporan bulanan tidak pernah terpotong: batasnya jumlah karyawan
        // aktif, bukan jumlah baris presensi.
        truncated: false,
      },
      {
        sheet: `Rekap ${bulan}-${parsed.data.year}`,
        fileName: `rekap-presensi-${parsed.data.year}-${bulan}.xlsx`,
        columnWidths: [16, 24, 8, 10, 8, 8, 14, 14, 14, 16, 14, 12],
      },
    );
  }

  return NextResponse.json(report);
});
