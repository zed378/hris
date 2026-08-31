import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import {
  readAccess,
  writeAccess,
  readAccessVersion,
  writeAccessVersion,
  forgetAccessVersion,
  forgetUser,
  readTenantGeneration,
  bumpTenantGeneration,
  resetAccessCache,
  type CachedAccess,
} from '../src/access-cache.ts';
import { disconnectRedis, redis, redisReady } from '../src/redis.ts';

/**
 * The permission cache and its two invalidation axes (PLAN/14 §5, §10.6).
 *
 * Against a real Redis, because what is being tested is the interaction between
 * two keys with different lifetimes — and a fake would only confirm that the
 * fake agrees with the assertion.
 *
 * Risk S2 in PLAN/14 is "the permission cache serves stale access after a
 * revocation", rated high probability and high impact. This file is the evidence
 * that it does not, and every case here is one way the cache could quietly keep
 * a permission alive after it was taken away.
 */

async function probe(): Promise<boolean> {
  if (!process.env['REDIS_URL']?.trim()) return false;
  if (!(await redisReady())) return false;
  await redis()!.ping();
  return true;
}

const available = await probe();

if (!available) {
  console.warn('REDIS_URL tidak dipasang — uji cache izin dilewati.');
}

afterAll(async () => {
  await disconnectRedis();
});

const sample = (version: number): CachedAccess => ({
  modules: ['leave', 'attendance'],
  permissions: ['leave.request.read.own'],
  accessVersion: version,
});

describe.skipIf(!available)('the resolution cache', () => {
  it('returns what was written, under the same version', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccess(tenant, user, sample(3));
    expect(await readAccess(tenant, user, 3)).toMatchObject({
      permissions: ['leave.request.read.own'],
      accessVersion: 3,
    });
  });

  /**
   * The whole invalidation design in one assertion: a bump does not delete
   * anything, it changes the key being looked for. There is no eviction to fail,
   * no ordering to get wrong, and no window where a stale entry is findable.
   */
  it('does not find an entry written under a different version', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccess(tenant, user, sample(3));
    expect(await readAccess(tenant, user, 4)).toBeNull();
  });

  it('keeps tenants and users apart', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const user = randomUUID();

    await writeAccess(tenantA, user, sample(1));

    expect(await readAccess(tenantA, user, 1)).not.toBeNull();
    expect(await readAccess(tenantB, user, 1)).toBeNull();
    expect(await readAccess(tenantA, randomUUID(), 1)).toBeNull();
  });

  /**
   * A malformed entry must read as a MISS, never as an empty permission set.
   *
   * The difference is the whole point: a miss falls through to the database and
   * the request is answered correctly, while `permissions: []` is a confident
   * answer that denies everything — and it would look like an authorization bug
   * rather than a cache bug.
   */
  it('treats a corrupt entry as a miss', async () => {
    const tenant = randomUUID();
    const user = randomUUID();
    const generation = await readTenantGeneration(tenant);

    await redis()!.set(`access:${tenant}:${generation}:${user}:1`, '{"nonsense":true}', 'EX', 60);
    expect(await readAccess(tenant, user, 1)).toBeNull();

    await redis()!.set(`access:${tenant}:${generation}:${user}:2`, 'not json at all', 'EX', 60);
    expect(await readAccess(tenant, user, 2)).toBeNull();
  });
});

describe.skipIf(!available)('the version axis — per user', () => {
  it('round-trips', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    expect(await readAccessVersion(tenant, user)).toBeNull();
    await writeAccessVersion(tenant, user, 7);
    expect(await readAccessVersion(tenant, user)).toBe(7);
  });

  /**
   * Deleting rather than overwriting is the safety property, and it is worth
   * asserting rather than assuming.
   *
   * A failed overwrite would leave the OLD version in place and a revoked user
   * would keep their permissions until it expired. A failed delete leaves
   * nothing, the next read falls through to the database, and the answer is
   * correct. `null` is the state that means "ask the source".
   */
  it('reads as null after a bump, so the next read consults the database', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccessVersion(tenant, user, 7);
    await forgetAccessVersion(tenant, user);

    expect(await readAccessVersion(tenant, user)).toBeNull();
  });

  it('refuses a corrupt version rather than trusting it', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await redis()!.set(`av:${tenant}:${user}`, 'not-a-number', 'EX', 30);
    expect(await readAccessVersion(tenant, user)).toBeNull();

    await redis()!.set(`av:${tenant}:${user}`, '-3', 'EX', 30);
    expect(await readAccessVersion(tenant, user)).toBeNull();
  });
});

describe.skipIf(!available)('the generation axis — per tenant', () => {
  /**
   * The axis that exists because the control plane cannot reach `iam`.
   *
   * Enabling or disabling a module changes what every user of a tenant may do,
   * and it is done by `hrms_platform`, which has no grant on `iam` at all (P11).
   * It cannot bump anybody's access version. Without this axis, disabling
   * payroll would leave it usable for the full lifetime of the cached
   * resolutions.
   */
  it('makes every cached resolution for the tenant unreachable at once', async () => {
    const tenant = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();

    await writeAccess(tenant, alice, sample(1));
    await writeAccess(tenant, bob, sample(1));

    expect(await readAccess(tenant, alice, 1)).not.toBeNull();
    expect(await readAccess(tenant, bob, 1)).not.toBeNull();

    await bumpTenantGeneration(tenant);

    // Neither is deleted; both have simply stopped being the key anybody looks
    // for. One increment, no scan, nothing to get wrong.
    expect(await readAccess(tenant, alice, 1)).toBeNull();
    expect(await readAccess(tenant, bob, 1)).toBeNull();
  });

  it('leaves other tenants untouched', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const user = randomUUID();

    await writeAccess(mine, user, sample(1));
    await writeAccess(theirs, user, sample(1));

    await bumpTenantGeneration(mine);

    expect(await readAccess(mine, user, 1)).toBeNull();
    expect(await readAccess(theirs, user, 1)).not.toBeNull();
  });

  it('writes new entries under the new generation, so caching resumes', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccess(tenant, user, sample(1));
    await bumpTenantGeneration(tenant);
    expect(await readAccess(tenant, user, 1)).toBeNull();

    await writeAccess(tenant, user, sample(1));
    expect(await readAccess(tenant, user, 1)).not.toBeNull();
  });

  /**
   * The generation key must never expire.
   *
   * If it did, it would reset to 0, and entries written under generation 0 would
   * become reachable AGAIN — a cache that resurrects revoked entitlement, which
   * is the worst behaviour available here. Asserted because an expiry is the
   * kind of thing added later "for tidiness".
   */
  it('has no expiry', async () => {
    const tenant = randomUUID();
    await bumpTenantGeneration(tenant);

    // -1 is redis-speak for "exists, and never expires".
    expect(await redis()!.ttl(`tenantgen:${tenant}`)).toBe(-1);
  });
});

describe.skipIf(!available)('forcing a revocation to take effect now', () => {
  it('removes a user across every generation and version', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccess(tenant, user, sample(1));
    await bumpTenantGeneration(tenant);
    await writeAccess(tenant, user, sample(2));

    const removed = await forgetUser(tenant, user);
    expect(removed).toBe(2);
  });

  it('resets both axes for one user', async () => {
    const tenant = randomUUID();
    const user = randomUUID();

    await writeAccess(tenant, user, sample(5));
    await writeAccessVersion(tenant, user, 5);

    await resetAccessCache(tenant, user);

    expect(await readAccessVersion(tenant, user)).toBeNull();
    expect(await readAccess(tenant, user, 5)).toBeNull();
  });
});

describe('without Redis', () => {
  /**
   * Every operation has to be safe with no Redis at all, because that is the
   * supported single-container configuration. A read reports a miss, a write
   * does nothing, and the caller resolves from the database — which is precisely
   * the behaviour of the day before the cache existed.
   */
  it('reads as a miss and writes without error', async () => {
    const saved = process.env['REDIS_URL'];
    await disconnectRedis();
    delete process.env['REDIS_URL'];

    try {
      const tenant = randomUUID();
      const user = randomUUID();

      await expect(writeAccess(tenant, user, sample(1))).resolves.toBeUndefined();
      await expect(readAccess(tenant, user, 1)).resolves.toBeNull();
      await expect(readAccessVersion(tenant, user)).resolves.toBeNull();
      await expect(bumpTenantGeneration(tenant)).resolves.toBeUndefined();
      await expect(readTenantGeneration(tenant)).resolves.toBe(0);
      await expect(forgetUser(tenant, user)).resolves.toBe(0);
    } finally {
      await disconnectRedis();
      if (saved) process.env['REDIS_URL'] = saved;
    }
  });
});
