import { definePublicRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness — apakah prosesnya hidup.
 *
 * **Tidak menyentuh basis data, dan itu keputusan yang menanggung beban.**
 *
 * Liveness dipakai orkestrator untuk memutuskan apakah kontainer perlu
 * DIMULAI ULANG. Probe liveness yang memeriksa basis data akan merestart
 * seluruh instance aplikasi ketika basis datanya sedang bermasalah — dan
 * restart massal saat basis data sedang tertekan membuat pemadaman yang tadinya
 * sepuluh detik menjadi sepuluh menit, karena setiap instance yang menyala
 * kembali langsung membuka pool koneksi baru ke basis data yang sudah kewalahan.
 *
 * Yang memeriksa basis data adalah `/api/ready`, dan bedanya bukan kehalusan:
 * readiness memutuskan apakah lalu lintas dialirkan, liveness memutuskan apakah
 * proses dibunuh.
 */
export const GET = definePublicRoute('GET /api/health', () =>
  Promise.resolve(
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }),
  ),
);
