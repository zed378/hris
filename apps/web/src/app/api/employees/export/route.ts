import writeXlsxFile from 'write-excel-file/node';
import { buildEmployeeExport, EMPLOYEE_COLUMNS } from '@hrms/core/employee';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNMASK = 'employee.pii.unmask';

/**
 * Mengunduh data karyawan sebagai .xlsx.
 *
 * Penyaring yang sedang aktif di layar ikut terbawa lewat query string, sehingga
 * yang terunduh persis yang terlihat. Ekspor yang selalu mengambil semuanya
 * membuat orang mengunduh 5.000 baris untuk membaca 12 — dan itu 5.000 baris PII
 * yang beredar tanpa alasan.
 */
export const GET = defineRoute('GET /api/employees/export', async (req, ctx) => {
  const url = new URL(req.url);

  const { rows, rowCount, truncated } = await buildEmployeeExport(
    ctx.tx,
    ctx.tenantId,
    {
      search: url.searchParams.get('search') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      departmentId: url.searchParams.get('departmentId') ?? undefined,
      // Izin yang sama dengan yang menentukan tampilan daftar. Bila tidak,
      // tombol "Ekspor" menjadi jalan pintas untuk mendapatkan NIK lengkap
      // seisi perusahaan tanpa pernah melewati pemeriksaan izin.
      canUnmask: ctx.access.permissions.includes(UNMASK),
    },
    {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    },
  );

  const sheet = rows.map((row, index) =>
    row.map((value) => ({
      value,
      type: String,
      ...(index === 0 ? { fontWeight: 'bold' as const, backgroundColor: '#E8EEF9' } : {}),
    })),
  );

  const buffer = await writeXlsxFile(sheet as never, {
    sheet: 'Data Karyawan',
    columns: EMPLOYEE_COLUMNS.map((column) => ({
      width: column.field === 'address' ? 40 : column.field === 'fullName' ? 24 : 18,
    })),
  }).toBuffer();

  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="karyawan-${stamp}.xlsx"`,
      // Jumlah baris dikembalikan sebagai header supaya klien dapat memberi tahu
      // pengguna bila hasilnya terpotong — hal yang tidak terlihat dari berkas
      // yang sudah terunduh.
      'x-export-rows': String(rowCount),
      'x-export-truncated': String(truncated),
      'cache-control': 'no-store',
    },
  });
});
