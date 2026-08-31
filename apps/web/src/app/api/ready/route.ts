import { log } from '@hrms/observability';
import { appClient } from '@hrms/db';
import { definePublicRoute } from '@/lib/define-route.ts';
import { rateLimitBackend } from '@/lib/rate-limit.ts';
import { signingMode } from '@hrms/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness — apakah instance ini layak menerima lalu lintas.
 *
 * Berbeda tujuan dari `/api/health`. Readiness memutuskan apakah lalu lintas
 * DIALIRKAN ke instance ini; liveness memutuskan apakah prosesnya DIBUNUH.
 * Instance yang basis datanya tidak terjangkau harus berhenti menerima
 * permintaan, tetapi tidak boleh direstart — restart tidak memperbaiki basis
 * data, dan hanya memperlama pemulihannya.
 *
 * Yang diperiksa sengaja minimal: satu query paling murah yang membuktikan
 * koneksi hidup DAN peran aplikasinya dapat membaca. `SELECT 1` membuktikan
 * yang pertama saja — dan aplikasi dengan koneksi hidup tetapi hak akses hilang
 * akan lolos probe lalu gagal pada setiap permintaan sungguhan.
 *
 * **Balasannya tidak memuat rincian.** Versi, nama basis data, dan pesan galat
 * asli adalah hadiah bagi siapa pun yang memindai; endpoint ini terbuka tanpa
 * autentikasi karena orkestrator memanggilnya sebelum ada sesi apa pun.
 * Rinciannya masuk ke log server, tempat orang yang berhak dapat membacanya.
 */
export const GET = definePublicRoute('GET /api/ready', async () => {
  const started = Date.now();

  try {
    // `plan` dipilih karena ia tabel katalog: tidak ber-`tenant_id`, sehingga
    // dapat dibaca tanpa konteks tenant, dan isinya selalu ada setelah migrasi.
    // Tabel bertenant akan mengembalikan nol baris karena RLS — hasil yang
    // benar, tetapi tidak membedakan "sehat" dari "kosong".
    await appClient().plan.findFirst({ select: { code: true } });

    /**
     * Two facts about HOW this instance is configured, reported alongside
     * readiness. Neither can make it unready — both are states it can serve
     * traffic in — and both are states that are otherwise invisible until they
     * cause a problem nobody can explain.
     *
     *   `rateLimit: 'in-process'` on a deployment with more than one replica
     *   means the configured limit is silently multiplied by the replica count.
     *
     *   `signing: 'hs256'` or `'hybrid'` means the shared secret can still MINT
     *   tokens. That is expected during the migration to asymmetric keys and
     *   alarming once it is supposed to be finished (PLAN/14 §6).
     *
     * Reported as plain words rather than a health verdict, because the right
     * answer depends on the topology and this endpoint does not know it.
     */
    return new Response(
      JSON.stringify({
        status: 'ready',
        checkMs: Date.now() - started,
        rateLimit: rateLimitBackend(),
        signing: await signingMode(),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    log.error({ scope: 'readiness', error });

    // 503, bukan 500. Orkestrator dan load balancer memperlakukan 503 sebagai
    // "jangan kirim lalu lintas ke sini untuk sementara"; 500 dibaca sebagai
    // galat aplikasi yang tetap layak menerima permintaan berikutnya.
    return new Response(JSON.stringify({ status: 'not_ready' }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': '5',
      },
    });
  }
});
