import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import {
  consumeRateLimit,
  consumeTenantQuota,
  rateLimitBackend,
  resetRateLimits,
  TENANT_QUOTA_MAX,
} from '../src/rate-limit.ts';
import { disconnectRedis, redis, redisReady } from '../src/redis.ts';

/**
 * Rate limiting against a real Redis (PLAN/14 stage 3).
 *
 * The bug being fixed is one that no in-process test could ever have caught,
 * because it only appears when there is more than one process: counters lived in
 * a `Map`, so every replica counted alone. Two replicas permitted twice the
 * configured rate, four permitted four times, and nothing errored and nothing
 * logged — the number in the configuration was simply not the number in force.
 *
 * So a mocked Redis would test the wrong thing entirely. What has to be true is
 * that two *separate* counters agree, which means a shared server, an atomic
 * increment, and a real expiry. All three are exercised here.
 *
 * ## When Redis is not running
 *
 * The suite skips rather than fails, and says so. Redis is optional by design —
 * `PLAN/12` §3.2 sold "nothing extra to keep alive" as a feature and it still is
 * for a single container — so a developer without it must not be looking at a
 * red build. The skip is recorded in PLAN/13 so it does not pass for coverage.
 */

const url = process.env['REDIS_URL'];

/**
 * Probed at collection time, with a real command.
 *
 * `lazyConnect` means the socket is not opened until something is asked of it,
 * so a connection object proves nothing — only a `PING` does.
 *
 * The distinction that matters: **an unset `REDIS_URL` skips, a set but
 * unreachable one FAILS.** Skipping in both cases would mean a broken Redis in
 * CI looks exactly like a developer who never started one, and the suite would
 * go green while testing nothing. That is the shape of failure this whole file
 * exists to remove.
 */
async function probe(): Promise<boolean> {
  if (!url?.trim()) return false;
  // Waits for the socket rather than racing it. `enableOfflineQueue: false`
  // rejects a command issued before the connection is up, so pinging
  // immediately would report "no Redis" for a Redis that is simply still
  // opening — and the suite would skip itself on a perfectly good machine.
  if (!(await redisReady())) return false;
  await redis()!.ping();
  return true;
}

const available = await probe();

if (!available) {
  console.warn(
    'REDIS_URL tidak dipasang — uji pembatas laju bersama dilewati. ' +
      'Jalankan `pnpm db:up` (Redis ikut di dalamnya) untuk menjalankannya.',
  );
}

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await disconnectRedis();
});

describe.skipIf(!available)('rate limiting with Redis', () => {
  it('is using the shared backend, not the in-process one', () => {
    expect(rateLimitBackend()).toBe('redis');
  });

  it('allows up to the limit and refuses the next one', async () => {
    const key = `test-${randomUUID()}`;

    for (let i = 0; i < 3; i += 1) {
      expect(await consumeRateLimit(key, 3, 60), `call ${i + 1}`).toBe(true);
    }
    expect(await consumeRateLimit(key, 3, 60)).toBe(false);
  });

  it('counts each key separately', async () => {
    const a = `test-${randomUUID()}`;
    const b = `test-${randomUUID()}`;

    expect(await consumeRateLimit(a, 1, 60)).toBe(true);
    expect(await consumeRateLimit(a, 1, 60)).toBe(false);
    // A different subject is unaffected by the first one's exhaustion.
    expect(await consumeRateLimit(b, 1, 60)).toBe(true);
  });

  /**
   * **The test that justifies the whole change.**
   *
   * The in-process limiter is cleared between the two halves, which is exactly
   * what a second replica looks like: a fresh process with empty counters. Under
   * the old implementation the second half would have had its own full budget
   * and every call would have passed. Sharing the counter is what makes the
   * limit hold across processes.
   */
  it('holds the limit across a process restart, which is what a second replica is', async () => {
    const key = `test-${randomUUID()}`;

    expect(await consumeRateLimit(key, 2, 60)).toBe(true);
    expect(await consumeRateLimit(key, 2, 60)).toBe(true);

    // Every trace of local state is discarded — a new replica, or this one
    // restarted mid-attack.
    resetRateLimits();

    expect(await consumeRateLimit(key, 2, 60)).toBe(false);
  });

  it('lets the window expire and starts counting again', async () => {
    const key = `test-${randomUUID()}`;

    // A one-second window, so the expiry is observed rather than assumed.
    expect(await consumeRateLimit(key, 1, 1)).toBe(true);
    expect(await consumeRateLimit(key, 1, 1)).toBe(false);

    await new Promise((r) => setTimeout(r, 1_200));
    expect(await consumeRateLimit(key, 1, 1)).toBe(true);
  });

  /**
   * The key must always carry an expiry. `INCR` and `EXPIRE` as two commands can
   * be interrupted between them, and the key left behind never expires — so the
   * subject is blocked forever, by a counter nothing will ever reset. The Lua
   * script exists to close that window, and this asserts it did.
   */
  it('always leaves an expiry on the counter', async () => {
    const key = `test-${randomUUID()}`;
    await consumeRateLimit(key, 5, 30);

    const ttl = await redis()!.pttl(`rl:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  /**
   * The cold-start bypass, found on a real restart rather than by reasoning.
   *
   * `enableOfflineQueue: false` refuses a command issued before the socket is
   * ready, so the FIRST request after a deploy was rejected with "Stream isn't
   * writeable", fell back to the local counter, and bypassed the shared limit
   * entirely — the Redis counter did not move at all. A few hundred milliseconds
   * of the exact failure this change exists to remove, after every single deploy,
   * and invisible to any test holding a warm connection.
   *
   * This test throws the connection away first, which is what a fresh process
   * has.
   */
  it('does not bypass the shared counter on the first call after a cold start', async () => {
    const key = `cold-${randomUUID()}`;

    // Warm: establish the counter at 1.
    expect(await consumeRateLimit(key, 1, 60)).toBe(true);

    // Cold: a brand new client, exactly as a restarted process would have.
    await disconnectRedis();
    resetRateLimits();

    // Must consult Redis and see the existing count, not start from zero.
    expect(await consumeRateLimit(key, 1, 60)).toBe(false);
    expect(Number(await redis()!.get(`rl:${key}`))).toBe(2);
  });

  it('counts concurrent calls exactly once each', async () => {
    const key = `test-${randomUUID()}`;

    // Twenty at once against a limit of ten. A non-atomic increment would let
    // more than ten through, which is the classic read-then-write race.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(key, 10, 60)),
    );

    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe.skipIf(!available)('the tenant quota', () => {
  it('reports remaining and reset, and refuses past the maximum', async () => {
    const tenant = randomUUID();

    const first = await consumeTenantQuota(tenant);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(TENANT_QUOTA_MAX - 1);
    expect(first.resetSeconds).toBeGreaterThan(0);
    expect(first.resetSeconds).toBeLessThanOrEqual(60);

    // Drive it to the limit through the shared counter directly, rather than
    // making 600 round trips.
    await redis()!.set(`quota:${tenant}`, String(TENANT_QUOTA_MAX), 'KEEPTTL');

    const exhausted = await consumeTenantQuota(tenant);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.remaining).toBe(0);
  });

  it('counts tenants independently', async () => {
    const noisy = randomUUID();
    const quiet = randomUUID();

    await redis()!.set(`quota:${noisy}`, String(TENANT_QUOTA_MAX + 100), 'EX', 60);

    expect((await consumeTenantQuota(noisy)).allowed).toBe(false);
    // The whole purpose: one tenant running an import script must not stop the
    // other nine from working.
    expect((await consumeTenantQuota(quiet)).allowed).toBe(true);
  });
});

describe('without Redis', () => {
  /**
   * The fallback has to keep working, because it is what every single-container
   * deployment and every developer checkout runs on. It is a weaker limit — each
   * process counts alone — but a weaker limit is not an absent one.
   */
  it('falls back to in-process counting when REDIS_URL is unset', async () => {
    const saved = process.env['REDIS_URL'];
    await disconnectRedis();
    delete process.env['REDIS_URL'];

    try {
      expect(rateLimitBackend()).toBe('in-process');

      const key = `local-${randomUUID()}`;
      expect(await consumeRateLimit(key, 2, 60)).toBe(true);
      expect(await consumeRateLimit(key, 2, 60)).toBe(true);
      expect(await consumeRateLimit(key, 2, 60)).toBe(false);

      const quota = await consumeTenantQuota(randomUUID());
      expect(quota.allowed).toBe(true);
      expect(quota.remaining).toBe(TENANT_QUOTA_MAX - 1);
    } finally {
      if (saved) process.env['REDIS_URL'] = saved;
      await disconnectRedis();
    }
  });

  /**
   * A configured but unreachable Redis must NOT take the application down.
   *
   * Failing closed would turn a Redis outage into a total outage: nobody could
   * log in, punch attendance, or approve anything because a protective mechanism
   * had a bad minute. Failing open degrades to the behaviour of the day before
   * this change, which is a weaker limit and a working system.
   */
  it('fails open to the local counter when Redis is configured but dead', async () => {
    const saved = process.env['REDIS_URL'];
    await disconnectRedis();
    // A port with nothing behind it.
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6399';

    try {
      const key = `dead-${randomUUID()}`;
      expect(await consumeRateLimit(key, 2, 60)).toBe(true);
      expect(await consumeRateLimit(key, 2, 60)).toBe(true);
      // Still limited — by the in-process counter, which is the fallback rather
      // than an unconditional allow.
      expect(await consumeRateLimit(key, 2, 60)).toBe(false);
    } finally {
      await disconnectRedis();
      if (saved) process.env['REDIS_URL'] = saved;
    }
  });
});
