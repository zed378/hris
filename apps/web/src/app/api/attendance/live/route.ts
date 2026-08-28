import { log } from '@hrms/observability';
import { listenTenant, TooManyStreamsError } from '@hrms/db';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Aliran presensi langsung (Server-Sent Events).
 *
 * SSE, bukan WebSocket. Yang dibutuhkan dasbor adalah satu arah — server memberi
 * tahu, klien tidak mengirim apa pun — dan SSE menyelesaikannya dengan HTTP
 * biasa: lewat proxy korporat tanpa negosiasi khusus, menyambung ulang sendiri,
 * dan tanpa satu pun pustaka di kedua sisi.
 *
 * Diakses lewat `fetch`, bukan `EventSource`. `EventSource` tidak dapat mengirim
 * header `Authorization`, sehingga memakainya berarti memindahkan token ke query
 * string — tempat ia berakhir di log akses proxy dan riwayat peramban.
 *
 * Denyut dikirim setiap 25 detik. Bukan hiasan: proxy dan load balancer memutus
 * koneksi yang diam, dan aliran presensi memang diam sepanjang hari kerja
 * kecuali pada jam datang dan pulang.
 */

const HEARTBEAT_MS = 25_000;

export const GET = defineRoute('GET /api/attendance/live', async (req, ctx) => {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stream: { close: () => Promise<void> } | undefined;

  try {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown): void => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            // Klien sudah pergi di antara dua peristiwa. Pembersihannya
            // dilakukan oleh `abort` di bawah; di sini cukup tidak menulis lagi.
          }
        };

        stream = await listenTenant(
          ctx.tenantId,
          (payload) => send('punch', payload),
          (error) => {
            log.error({ scope: 'attendance-live', tenantId: ctx.tenantId, error });
            send('error', { message: 'Koneksi peristiwa terputus' });
          },
        );

        send('ready', { tenantId: ctx.tenantId });
        heartbeat = setInterval(() => send('ping', { at: new Date().toISOString() }), HEARTBEAT_MS);

        // Penutupan digantung pada sinyal abort request, bukan pada `cancel`
        // saja. Peramban yang tabnya ditutup tidak selalu memicu `cancel`, dan
        // koneksi PostgreSQL yang tidak dilepas akan menumpuk sampai habis.
        req.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          void stream?.close();
          try {
            controller.close();
          } catch {
            // Sudah tertutup.
          }
        });
      },

      async cancel() {
        clearInterval(heartbeat);
        await stream?.close();
      },
    });

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // Mematikan buffering nginx. Tanpa ini, peristiwa menumpuk di proxy dan
        // dasbor "langsung" tertinggal beberapa detik sampai buffernya penuh.
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    await stream?.close();

    if (error instanceof TooManyStreamsError) {
      // 503, bukan 500: keadaannya sementara dan klien boleh mencoba lagi.
      // Dasbor akan jatuh ke polling, yang memang jaring pengamannya.
      return apiError(
        503,
        ErrorCode.INTERNAL,
        'Terlalu banyak dasbor langsung terbuka. Data tetap dapat dimuat berkala.',
        ctx.correlationId,
      );
    }
    throw error;
  }
});
