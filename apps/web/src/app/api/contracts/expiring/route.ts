import { NextResponse } from 'next/server';
import { listExpiringContracts } from '@hrms/core/employee';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kontrak yang akan berakhir.
 *
 * Yang sudah lewat ikut ditampilkan dengan `daysLeft` negatif, dan itu disengaja:
 * kontrak yang terlanjur lewat sudah menjadi masalah hukum, bukan lagi pengingat.
 * Menyembunyikannya dari daftar berarti menyembunyikan justru yang paling mendesak.
 */
export const GET = defineRoute('GET /api/contracts/expiring', async (req, ctx) => {
  const url = new URL(req.url);
  const contracts = await listExpiringContracts(ctx.tx, ctx.tenantId, {
    withinDays: Number(url.searchParams.get('withinDays') ?? 90),
  });

  return NextResponse.json({
    contracts,
    summary: {
      expired: contracts.filter((c) => c.daysLeft < 0).length,
      within7: contracts.filter((c) => c.daysLeft >= 0 && c.daysLeft <= 7).length,
      within30: contracts.filter((c) => c.daysLeft > 7 && c.daysLeft <= 30).length,
      within90: contracts.filter((c) => c.daysLeft > 30).length,
    },
  });
});
