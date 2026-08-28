import { exportTenantData } from '@hrms/core/tenant';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNMASK = 'employee.pii.unmask';

/**
 * Ekspor seluruh data tenant (DoD Fase 6, UU PDP No. 27/2022 — portabilitas).
 *
 * Izin `employee.pii.unmask` menentukan apakah NIK, NPWP, dan nomor rekening
 * ikut dalam bentuk aslinya. Tanpa izin itu ekspornya tetap berjalan, hanya
 * kolom PII-nya tersamar — dan itu memang ekspor yang berbeda gunanya:
 * pemindahan sistem menuntut nilai asli, sedangkan analisis internal tidak.
 *
 * Setiap pemanggilan diaudit di lapisan core, termasuk apakah PII disertakan.
 * Ekspor lengkap satu perusahaan adalah salah satu operasi paling sensitif yang
 * dapat dilakukan siapa pun di dalam sistem ini.
 */
export const GET = defineRoute('GET /api/tenant/export', async (_req, ctx) => {
  const includePii = ctx.access.permissions.includes(UNMASK);

  const data = await exportTenantData(
    ctx.tx,
    ctx.tenantId,
    { includePii, modules: new Set(ctx.access.modules) },
    ctx.userId,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `hrms-${data.meta.tenantCode}-${stamp}.json`;

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      // Berkas ini memuat seluruh data kepegawaian satu perusahaan. Ia tidak
      // boleh tertinggal di cache mana pun.
      'cache-control': 'no-store, private',
      // Dinyatakan sebagai header supaya klien dapat memperingatkan tanpa
      // mengurai seluruh berkas yang bisa berukuran puluhan megabita.
      'x-export-pii': String(includePii),
      'x-export-truncated': data.truncated.join(',') || 'false',
    },
  });
});
