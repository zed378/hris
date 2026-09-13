import { log } from '@hrms/observability';
import { listenTenant, TooManyStreamsError } from '@hrms/db';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live attendance stream (Server-Sent Events).
 *
 * SSE, not WebSocket. What the dashboard needs is one-way — server informs,
 * client sends nothing — and SSE delivers it over plain HTTP: through corporate
 * proxies without special negotiation, with its own reconnection, and with not
 * a single library on either side.
 *
 * Accessed via `fetch`, not `EventSource`. `EventSource` cannot send the
 * `Authorization` header, so using it means moving the token into the query
 * string — where it lands in proxy access logs and browser history.
 *
 * Heartbeats are sent every 25 seconds. Not decoration: proxies and load
 * balancers drop idle connections, and the attendance stream is idle all day
 * except at clock-in and clock-out.
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
            // The client has left between two events. Cleanup is done by the
            // `abort` handler below; here it is enough to stop writing.
          }
        };

        stream = await listenTenant(
          ctx.tenantId,
          (payload) => send('punch', payload),
          (error) => {
            log.error({ scope: 'attendance-live', tenantId: ctx.tenantId, error });
            send('error', { message: 'Event stream disconnected' });
          },
        );

        send('ready', { tenantId: ctx.tenantId });
        heartbeat = setInterval(() => send('ping', { at: new Date().toISOString() }), HEARTBEAT_MS);

    // The close is tied to the request's abort signal, not just to `cancel`.
    // A browser closing the tab does not always trigger `cancel`, and a
    // PostgreSQL connection that is never closed will pile up until exhausted.
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
        /**
         * Asks nginx not to buffer the stream.
         *
         * This header used to carry a stronger claim than the evidence
         * supported: that without it events pile up in the proxy and the live
         * dashboard falls seconds behind until the buffer fills. **Measured, it
         * did not.** `ops/proxy-test` runs the stream behind an nginx configured
         * to IGNORE this header, and the punch still arrived in 0.08 s — the same
         * as with it honoured, and the same as with the stream gzipped. nginx
         * forwards each upstream chunk as it arrives; its buffering protects
         * against slow clients, which is a different problem.
         *
         * The header stays. It is correct, it costs nothing, and other proxies —
         * and other nginx builds and configurations — do act on it. What has
         * been corrected is the claim, not the code.
         */
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    await stream?.close();

    if (error instanceof TooManyStreamsError) {
      // 503, not 500: the situation is temporary and the client is allowed to retry.
      // The dashboard falls back to polling, which is its own safety net.
      return apiError(
        503,
        ErrorCode.INTERNAL,
         'Too many live dashboards open. Data can still be loaded on a timer.',
        ctx.correlationId,
      );
    }
    throw error;
  }
});
