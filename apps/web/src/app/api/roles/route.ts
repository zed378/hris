import { NextResponse } from 'next/server';
import { listRoles } from '@hrms/core/iam';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daftar peran, beserta **katalog izin** yang tersedia.
 *
 * Katalognya ikut dikirim karena layar penyunting peran tidak dapat menampilkan
 * kotak centang untuk izin yang tidak diketahuinya. Mengirimnya terpisah berarti
 * dua permintaan yang harus tiba bersama sebelum layar dapat digambar, dan
 * jendela di antaranya adalah layar yang menampilkan peran tanpa satu pun izin
 * — yang terbaca sebagai "peran ini tidak punya hak apa pun".
 *
 * Izin yang modulnya tidak dilanggan tenant ini TIDAK disaring di sini. Peran
 * boleh memuatnya; yang menolak adalah gerbang rute dengan 402 (P8). Menyaringnya
 * berarti mencabut diam-diam konfigurasi peran ketika langganan turun, lalu
 * gagal mengembalikannya ketika langganan naik lagi.
 */
export const GET = defineRoute('GET /api/roles', async (_req, ctx) => {
  const [roles, catalog] = await Promise.all([
    listRoles(ctx.tx, ctx.tenantId),
    ctx.tx.permission.findMany({
      orderBy: [{ moduleCode: 'asc' }, { code: 'asc' }],
      select: { code: true, moduleCode: true, description: true },
    }),
  ]);

  return NextResponse.json({ roles, catalog });
});
