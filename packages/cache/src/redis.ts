import { Redis } from 'ioredis';
import { log } from '@hrms/observability';

/**
 * The Redis connection, or none (PLAN/14 §9.2, stage 3).
 *
 * Redis is **optional on purpose**. With no `REDIS_URL` the application behaves
 * exactly as it did before — one process, in-memory counters — and every test,
 * every local checkout, and every single-container deployment keeps working with
 * nothing extra to run. `PLAN/12` §3.2 sold "no Redis to keep alive" as a
 * feature, and it still is right up until there are two web replicas.
 *
 * What changes is that the second replica is no longer a silent correctness
 * failure. In-process counters mean each replica counts alone: with two, the
 * effective limit is double the configured one, with four it is quadruple, and
 * nothing errors, nothing logs, and the number in the config is simply not the
 * number in force. That is the bug being fixed here, and it exists **today** —
 * horizontal scaling is one of the stated reasons for the split, so it would
 * have arrived precisely when the system was under enough load to need the
 * limiter.
 *
 * ## One connection, created lazily
 *
 * Serverless-style route handlers can be instantiated many times per process;
 * building a connection per call would exhaust Redis long before it helped
 * anything. The client is a module-level singleton, and `lazyConnect` means an
 * unused deployment never opens a socket at all.
 */

let client: Redis | null = null;
let attempted = false;

/** True once a connection error has been logged, so it is said once, not per request. */
let degradedLogged = false;

export function redis(): Redis | null {
  const url = process.env['REDIS_URL'];
  if (!url?.trim()) return null;

  if (!attempted) {
    attempted = true;
    client = new Redis(url, {
      lazyConnect: true,
      // Fail fast rather than queue. A rate limiter that waits on a dead Redis
      // turns a degraded dependency into a slow application, which is worse than
      // the thing it was protecting against — every request pays the timeout.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 500,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    client.on('error', (error: Error) => {
      if (degradedLogged) return;
      degradedLogged = true;
      log.error({ scope: 'redis', event: 'unavailable', error });
    });

    client.on('ready', () => {
      degradedLogged = false;
      log.info({ scope: 'redis', event: 'ready' });
    });

    void client.connect().catch(() => {
      // Already reported by the error handler. Swallowed here so a missing Redis
      // cannot crash the process at import time.
    });
  }

  return client;
}

/**
 * Waits until the connection is usable, or gives up.
 *
 * `enableOfflineQueue: false` means a command issued before the socket is ready
 * is rejected outright rather than buffered — deliberately, because a queue
 * turns a dead Redis into a slow application, and every request then pays the
 * timeout. The consequence is that the first request or two after a cold start
 * may find the socket still opening and fall back to local counting, which is
 * correct and momentary.
 *
 * Anything that needs a definite answer — a readiness probe, a test that must
 * not silently skip — waits here instead of guessing.
 */
export async function redisReady(timeoutMs = 3_000): Promise<boolean> {
  const connection = redis();
  if (!connection) return false;
  if (connection.status === 'ready') return true;

  return new Promise<boolean>((resolveReady) => {
    const timer = setTimeout(() => finish(false), timeoutMs);

    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      connection.off('ready', onReady);
      connection.off('error', onError);
      resolveReady(ok);
    };

    const onReady = (): void => finish(true);
    // Not `finish(false)`: ioredis retries, and one failed attempt during
    // startup is ordinary. The timeout is what decides.
    const onError = (): void => undefined;

    connection.on('ready', onReady);
    connection.on('error', onError);
  });
}

/**
 * A fixed-window counter, incremented atomically.
 *
 * `INCR` then `PEXPIRE` as two commands has a real race: a process that dies
 * between them leaves a key with no expiry, and that key then blocks its subject
 * forever. One script, one round trip, no window in between.
 *
 * Returns the count after incrementing and the milliseconds remaining, so a
 * caller can build a `Retry-After` without a second call.
 */
const WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { current, redis.call('PTTL', KEYS[1]) }
`;

export interface WindowCount {
  count: number;
  resetMs: number;
}

/**
 * Counts one hit against a window, or returns `null` when Redis cannot answer.
 *
 * `null` means "no opinion", never "allowed" or "denied" — the decision belongs
 * to the caller, which falls back to its in-process counter. Encoding a verdict
 * here would hide the degradation behind a boolean, and the caller could not
 * tell a genuine allow from a Redis timeout.
 */
export async function countInWindow(
  key: string,
  windowSeconds: number,
): Promise<WindowCount | null> {
  const connection = redis();
  if (!connection) return null;

  const run = async (): Promise<WindowCount> => {
    const [count, ttl] = (await connection.eval(
      WINDOW_SCRIPT,
      1,
      key,
      String(windowSeconds * 1000),
    )) as [number, number];

    return { count, resetMs: ttl > 0 ? ttl : windowSeconds * 1000 };
  };

  /**
   * One retry, and only while the socket is still opening.
   *
   * Measured on a real restart: the first request after a cold start was
   * rejected with "Stream isn't writeable" — `enableOfflineQueue: false` refuses
   * commands before the connection is ready — so it fell back to the local
   * counter and **bypassed the shared limit entirely**. The Redis counter did
   * not move. That is the exact failure this change exists to remove, reappearing
   * for a few hundred milliseconds after every single deploy, and it would never
   * show up in a test that had a warm connection.
   *
   * The wait is bounded and applies only to the cold-start window. A Redis that
   * is genuinely down reports `end`, never becomes ready, and falls through to
   * the local counter after the timeout — degraded, as intended, rather than
   * hanging every request.
   */
  const connecting = (): boolean =>
    connection.status === 'connecting' ||
    connection.status === 'connect' ||
    connection.status === 'reconnecting';

  if (connecting()) await redisReady(1_000);

  try {
    return await run();
  } catch (error) {
    if (connecting() && (await redisReady(1_000))) {
      try {
        return await run();
      } catch {
        // Falls through to the degraded path below.
      }
    }

    if (!degradedLogged) {
      degradedLogged = true;
      log.error({ scope: 'redis', event: 'command-failed', key, error });
    }
    return null;
  }
}

/** Closes the connection. For tests and graceful shutdown. */
export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  const closing = client;
  client = null;
  attempted = false;
  degradedLogged = false;
  await closing.quit().catch(() => closing.disconnect());
}
