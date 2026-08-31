import { redis } from './redis.ts';

/**
 * The permission cache (PLAN/14 §5, option C).
 *
 * This is the piece that decides whether extracting auth is a success or a
 * latency regression, and it is not the part most designs spend their time on.
 *
 * Every authenticated request resolves the caller's effective access: six
 * queries against `iam` and `tenant`. In one process, on one connection, that is
 * cheap. **Across a service boundary it is a remote call on every single
 * request**, and it lands on the login service — the one that is CPU-bound on
 * argon2.
 *
 * §5 weighs three answers. A remote check per request is correct and slow. A fat
 * token is fast and cannot be revoked before it expires. This is the third: the
 * backend resolves from a shared cache, and the cache is invalidated by the
 * access version rather than by a message anyone has to remember to send.
 *
 * ## The version is IN the key, not beside it
 *
 * `access:{tenant}:{user}:{version}` — so a permission change does not
 * invalidate anything, it simply stops anyone reading the old entry. There is no
 * delete to get wrong, no ordering between the write and the eviction, and no
 * window in which a stale entry is still findable.
 *
 * The old entry is not deleted at all; it expires. That is deliberate: a request
 * already in flight carrying the previous token can still complete against the
 * data it was authorized under, rather than failing halfway through.
 *
 * **This only works because `av` is compared on every request** — enforced in
 * stage 2, before this existed. Without that comparison a token carrying an old
 * version would keep finding its old entry and keep its revoked permissions
 * until the token expired. The two mechanisms are one mechanism.
 *
 * ## The TTL is a backstop, not the invalidation
 *
 * Correctness comes from the version in the key. The TTL exists so that entries
 * for users who stop making requests do not sit in Redis forever, and it is
 * deliberately short enough that a bug in the versioning costs minutes rather
 * than days.
 */

const TTL_SECONDS = 300;

export interface CachedAccess {
  modules: string[];
  permissions: string[];
  accessVersion: number;
}

function key(
  tenantId: string,
  userId: string,
  accessVersion: number,
  generation: number,
): string {
  return `access:${tenantId}:${generation}:${userId}:${accessVersion}`;
}

/**
 * The tenant's entitlement generation.
 *
 * A second invalidation axis, and it exists because of a constraint that only
 * appears once the cache does: **the access version is per USER, and entitlement
 * changes are per TENANT.**
 *
 * Enabling or disabling a module changes what every user of that tenant may do,
 * and it is done by the CONTROL PLANE — which connects as `hrms_platform` and
 * has no grant on `iam` at all (P11). It cannot bump anybody's access version
 * even if it wanted to. Without a second axis, disabling payroll would leave it
 * usable for the lifetime of the cached resolutions: five minutes of a module
 * the customer has stopped paying for, or five minutes of one they were cut off
 * from for a reason.
 *
 * Redis is not RLS-bound and belongs to no plane, so both planes can reach this.
 * Incrementing it makes every cached resolution for the tenant unreachable at
 * once — no scan, no delete, nothing to get wrong.
 *
 * ## When Redis is unavailable during a bump
 *
 * The increment is lost and stale entries survive until their TTL. Bounded, and
 * worth stating: this axis makes the window five minutes instead of unbounded,
 * and it does not make it zero.
 */
function generationKey(tenantId: string): string {
  return `tenantgen:${tenantId}`;
}

export async function readTenantGeneration(tenantId: string): Promise<number> {
  const connection = redis();
  if (!connection) return 0;

  try {
    const raw = await connection.get(generationKey(tenantId));
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Called when a tenant's entitlement changes — a module toggled, a plan
 * switched. Every cached resolution for the tenant becomes unreachable.
 *
 * No expiry on this key deliberately. If it expired, the generation would reset
 * to 0 and old entries written under generation 0 would become reachable AGAIN —
 * a cache that resurrects revoked entitlement, which is the worst behaviour
 * available here.
 */
export async function bumpTenantGeneration(tenantId: string): Promise<void> {
  const connection = redis();
  if (!connection) return;

  try {
    await connection.incr(generationKey(tenantId));
  } catch {
    // Bounded by the resolution TTL. Reported once per outage by `redis.ts`.
  }
}

/**
 * Reads a cached resolution, or `null`.
 *
 * `null` means "ask the source", never "denied". A cache miss and a Redis outage
 * are the same answer here on purpose: both mean this layer cannot help, and the
 * caller must fall back to resolving properly. Encoding a denial would turn a
 * Redis blip into an authorization failure, which is the one direction this must
 * never fail in.
 */
export async function readAccess(
  tenantId: string,
  userId: string,
  accessVersion: number,
): Promise<CachedAccess | null> {
  const connection = redis();
  if (!connection) return null;

  try {
    const generation = await readTenantGeneration(tenantId);
    const raw = await connection.get(key(tenantId, userId, accessVersion, generation));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CachedAccess;

    // Guarded rather than trusted. The entry could have been written by an older
    // deployment with a different shape, and a malformed cache entry must degrade
    // to a miss rather than crash a request or — far worse — produce an
    // `undefined` permission list that quietly denies everything.
    if (
      !Array.isArray(parsed.modules) ||
      !Array.isArray(parsed.permissions) ||
      typeof parsed.accessVersion !== 'number'
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Stores a resolution under its version.
 *
 * Failures are swallowed. A cache that cannot be written is a cache that will be
 * missed next time, which is slow; a request that fails because the cache could
 * not be written is broken. Those are not the same, and only one of them is
 * acceptable.
 */
export async function writeAccess(
  tenantId: string,
  userId: string,
  access: CachedAccess,
): Promise<void> {
  const connection = redis();
  if (!connection) return;

  try {
    const generation = await readTenantGeneration(tenantId);
    await connection.set(
      key(tenantId, userId, access.accessVersion, generation),
      JSON.stringify(access),
      'EX',
      TTL_SECONDS,
    );
  } catch {
    // Deliberately silent per call. `redis.ts` reports an unreachable server
    // once per outage; repeating it here would drown the log during exactly the
    // incident someone is trying to read.
  }
}

/**
 * Drops every cached entry for one user, across all versions.
 *
 * Not needed for correctness — bumping the access version already makes old
 * entries unreachable — and provided for the case where correctness is not what
 * is wanted: an administrator revoking access during an incident wants the
 * entries gone now, not expiring quietly over the next five minutes.
 *
 * `SCAN`, never `KEYS`. `KEYS` blocks the whole server while it walks the
 * keyspace, and a security action taken during an incident is the worst possible
 * moment to stall every other request on the system.
 */
export async function forgetUser(tenantId: string, userId: string): Promise<number> {
  const connection = redis();
  if (!connection) return 0;

  const pattern = `access:${tenantId}:*:${userId}:*`;
  let cursor = '0';
  let removed = 0;

  try {
    do {
      const [next, found] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (found.length > 0) removed += await connection.del(...found);
    } while (cursor !== '0');
  } catch {
    return removed;
  }

  return removed;
}

export const ACCESS_CACHE_TTL_SECONDS = TTL_SECONDS;

/**
 * The current access version, cached separately from the resolution.
 *
 * A cache keyed by version is only safe if something establishes what the
 * current version IS — otherwise a revoked user's old token keeps finding its
 * old entry, and the cache becomes the thing that defeats revocation.
 *
 * Reading it from `iam.access_versions` is one cheap indexed query, which is
 * fine today and impossible after stage 6: the backend will have no grant on
 * `iam` at all. So it is cached too, and the two keys have very different
 * lifetimes and very different consequences:
 *
 *   the RESOLUTION  keyed by version, so a bump makes old entries unreachable
 *                   and there is nothing to invalidate
 *   the VERSION     short-lived, and DELETED on a bump rather than overwritten
 *
 * ## Why delete rather than write
 *
 * Writing the new version means a write that fails leaves the OLD value in
 * place, and a revoked user keeps their permissions until it expires. Deleting
 * means a failure leaves NO value, the next read falls through to the database,
 * and the answer is correct. Both failures are possible; only one of them is
 * safe, and it is not the tidy-looking one.
 *
 * The TTL is short for the same reason: it bounds how long a missed delete can
 * matter, and the ceiling on that damage should be measured in seconds.
 */
const VERSION_TTL_SECONDS = 30;

function versionKey(tenantId: string, userId: string): string {
  return `av:${tenantId}:${userId}`;
}

/** The cached current version, or `null` — meaning "ask the database". */
export async function readAccessVersion(
  tenantId: string,
  userId: string,
): Promise<number | null> {
  const connection = redis();
  if (!connection) return null;

  try {
    const raw = await connection.get(versionKey(tenantId, userId));
    if (raw === null) return null;

    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeAccessVersion(
  tenantId: string,
  userId: string,
  version: number,
): Promise<void> {
  const connection = redis();
  if (!connection) return;

  try {
    await connection.set(versionKey(tenantId, userId), String(version), 'EX', VERSION_TTL_SECONDS);
  } catch {
    // A cache that cannot be written is slower, not wrong.
  }
}

/**
 * Called when a user's access changes. Removes the cached version so the next
 * read consults the database.
 *
 * Deliberately does NOT remove the resolutions: they are keyed by version, so
 * the new version simply does not find them. Leaving them lets a request already
 * in flight under the old token complete against the data it was authorized
 * with, rather than failing halfway through.
 */
export async function forgetAccessVersion(tenantId: string, userId: string): Promise<void> {
  const connection = redis();
  if (!connection) return;

  try {
    await connection.del(versionKey(tenantId, userId));
  } catch {
    // The TTL is the backstop. Thirty seconds, by design.
  }
}

export const ACCESS_VERSION_TTL_SECONDS = VERSION_TTL_SECONDS;

/**
 * Discards every cached decision for one user. For tests, and for an operator
 * who wants a revocation to take effect now rather than over the next window.
 *
 * Production code does not normally call this: `bumpAccessVersion` and
 * `bumpTenantGeneration` are the ordinary paths, and they invalidate by making
 * entries unreachable rather than by deleting them.
 */
export async function resetAccessCache(tenantId: string, userId: string): Promise<void> {
  await forgetAccessVersion(tenantId, userId);
  await forgetUser(tenantId, userId);
}
