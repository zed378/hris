import type { TenantClient } from '@hrms/db';
import {
  readAccess,
  writeAccess,
  readAccessVersion,
  writeAccessVersion,
} from '@hrms/cache';
import { resolveEffectiveAccess, type EffectiveAccess } from './resolve-access.ts';

/**
 * One authorization decision, in the shape it will have over the wire
 * (PLAN/14 stage 4).
 *
 * Today the gateway composes this decision itself: it calls
 * `resolveEffectiveAccess`, compares the access version, checks the module, then
 * checks the permission, and turns each outcome into an HTTP status. Four steps
 * whose ORDER carries meaning — 402 before 403, staleness before either — spread
 * across a route wrapper that is also doing rate limiting, tenant-header
 * checking, and error shaping.
 *
 * That is fine while it is one process. It becomes the hard part of the split
 * the moment it is not: every one of those steps has to move to the auth service
 * together, and any that stays behind quietly answers a different question from
 * the one the service is answering.
 *
 * So the decision is made a THING rather than a sequence. This function is the
 * seam. When authorization becomes remote (PLAN/14 §5, option C), what replaces
 * it is an HTTP call returning this same `AccessDecision`, and the gateway's
 * mapping from decision to status code does not change at all.
 *
 * ## Why the transaction is still a parameter
 *
 * Because it is still in-process, and pretending otherwise would cost something
 * real. The handler needs a transaction for its own work; authorizing on a
 * separate one would mean two connections per request, today, to buy a shape we
 * do not need yet.
 *
 * `tx` is the parameter that DISAPPEARS when this becomes a network call. Nothing
 * else in the signature changes — which is the point of writing it this way now.
 *
 * ## Why the decision is not a boolean
 *
 * Because "no" has three meanings here and they are not interchangeable:
 *
 *   - `stale` — the session is valid, its permissions are out of date. The client
 *     refreshes and retries and the user sees nothing.
 *   - `module` — the tenant does not subscribe. A customer can act on this.
 *   - `permission` — the tenant subscribes and this person may not. A customer
 *     cannot act on it; their administrator can.
 *
 * Collapsing them into `false` is how a subscription problem starts being
 * reported to users as "access denied", which sends them to the wrong person.
 */

export interface AccessRequest {
  tenantId: string;
  userId: string;
  /** The `av` claim carried by the token being presented. */
  tokenAccessVersion: number;
  /** The module the route belongs to. */
  module: string;
  /** The permission the route requires, or `null` when it requires none. */
  permission: string | null;
}

export type AccessDenial = 'stale' | 'module' | 'permission';

export type AccessDecision =
  | { allowed: true; access: EffectiveAccess }
  | { allowed: false; reason: AccessDenial; access: EffectiveAccess };

/**
 * Decides whether one request may proceed.
 *
 * The order of the checks is deliberate and must not be rearranged:
 *
 *   1. **Staleness first.** A token whose access version disagrees with the
 *      record describes permissions that are no longer true. Judging a module or
 *      a permission against it would be answering with information already known
 *      to be out of date — and would sometimes answer 403 for a user who, after
 *      refreshing, is perfectly entitled.
 *   2. **Module before permission** (P8). "Your plan does not include this
 *      module" is something a customer can act on; "access denied" is not. A
 *      tenant who has not bought payroll should be told that, not told they lack
 *      a permission their administrator cannot grant them.
 *   3. **Permission last** (P9). The screen hides it, the server refuses it.
 */
export async function decideAccess(
  tx: TenantClient,
  request: AccessRequest,
): Promise<AccessDecision> {
  const access = await resolveAccessCached(tx, request);

  if (request.tokenAccessVersion !== access.accessVersion) {
    return { allowed: false, reason: 'stale', access };
  }

  if (!access.modules.includes(request.module)) {
    return { allowed: false, reason: 'module', access };
  }

  if (request.permission !== null && !access.permissions.includes(request.permission)) {
    return { allowed: false, reason: 'permission', access };
  }

  return { allowed: true, access };
}

/**
 * The same resolution, served from Redis when it can be (PLAN/14 §5 option C).
 *
 * Six queries per authenticated request is cheap in one process on one
 * connection, and is the whole problem the moment authorization crosses a
 * network. This is the third of the three answers §5 weighs: not a remote call
 * per request (correct and slow), not a fat token (fast and unrevokable), but a
 * shared cache invalidated by the access version.
 *
 * ## Two reads, not one, and the order matters
 *
 * The version comes FIRST and separately. A cache keyed by version is only safe
 * if something establishes what the current version is — otherwise a revoked
 * user's old token keeps finding its old entry, and the cache becomes the thing
 * that defeats revocation. The version read is one indexed row; the resolution
 * it guards is six queries and a set of joins.
 *
 * ## Every failure falls through to the database
 *
 * No Redis, a miss, a malformed entry, a timeout — all the same answer: resolve
 * properly. The cache can make this faster and it can never make it wrong, which
 * is the only acceptable arrangement for the layer that decides who may read
 * whose salary.
 *
 * ## What remains for stage 6
 *
 * The version still falls back to `iam.access_versions`, and after the split the
 * backend will have no grant on `iam` at all. At that point the fallback becomes
 * a call to the auth service — the same shape, a different source — and it will
 * be reached only on a cache miss rather than on every request.
 */
async function resolveAccessCached(
  tx: TenantClient,
  request: AccessRequest,
): Promise<EffectiveAccess> {
  const cachedVersion = await readAccessVersion(request.tenantId, request.userId);

  if (cachedVersion !== null) {
    const hit = await readAccess(request.tenantId, request.userId, cachedVersion);
    if (hit) {
      return {
        modules: hit.modules,
        permissions: hit.permissions,
        accessVersion: hit.accessVersion,
      };
    }
  }

  const access = await resolveEffectiveAccess(tx, request.tenantId, request.userId);

  // Written after the resolution, never before. Writing the version first would
  // leave a window where the version says "current" and the resolution it points
  // at does not yet exist — a miss, which is harmless, but the reverse ordering
  // costs nothing and removes the question.
  await writeAccess(request.tenantId, request.userId, access);
  await writeAccessVersion(request.tenantId, request.userId, access.accessVersion);

  return access;
}
