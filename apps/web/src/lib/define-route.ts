import { log, runWithContext } from '@hrms/observability';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { withTenant, type TenantClient } from '@hrms/db';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import { verifyAccessToken, TokenVerificationError } from '@hrms/core/auth';
import { decideAccess, type EffectiveAccess } from '@hrms/core/iam';
import {
  authServiceUrl,
  authorizeRemotely,
  AUTH_UNAVAILABLE_STATUS,
} from './auth-client.ts';
import { ROUTE_MANIFEST, type RouteId, type RouteRule } from './route-manifest.ts';
import { consumeRateLimit, consumeTenantQuota, TENANT_QUOTA_MAX } from '@hrms/cache';

export interface RequestContext {
  correlationId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface RouteParams {
  /** The dynamic URL segments, e.g. `[id]` in /api/roles/[id]/permissions. */
  params: Record<string, string>;
}

export interface AuthenticatedContext extends RequestContext, RouteParams {
  tenantId: string;
  tenantCode: string;
  userId: string;
  email: string;
  access: EffectiveAccess;
  /** A transaction with the tenant context already set. RLS fully in force. */
  tx: TenantClient;
}

type PublicHandler = (req: Request, ctx: RequestContext & RouteParams) => Promise<Response>;
type AuthedHandler = (req: Request, ctx: AuthenticatedContext) => Promise<Response>;

/**
 * The second argument Next gives a route handler.
 *
 * `params` has been a Promise since Next 15. Resolved here once, so every
 * handler receives a plain object and nobody forgets to await it — `params.id`
 * on a Promise is `undefined` rather than an error, so that omission would slip
 * through silently all the way to production.
 */
type NextRouteContext = { params?: Promise<Record<string, string>> | Record<string, string> };

function fail(
  status: number,
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, string[]>,
): NextResponse<ApiError> {
  const body: ApiError = { error: { code, message, correlationId } };
  if (details) body.error.details = details;
  return NextResponse.json(body, { status });
}

function contextFrom(req: Request): RequestContext {
  return {
    correlationId: req.headers.get('x-correlation-id') ?? randomUUID(),
    ip:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

/**
 * Wraps every API handler in the same chain of decisions.
 *
 * Its order is not taste — each step assumes the one before it:
 *
 *   1. Manifest    — an unregistered route returns 404, not 500. An endpoint
 *                    exposed by accident can never be reached (P7).
 *   2. Rate limit  — before any expensive work (argon2, queries).
 *   3. Token       — audience `hrms-tenant`; a superuser token fails here (P11).
 *   4. X-Tenant-ID — when sent, it MUST match the `tid` claim. The header is
 *                    never trusted alone; it confirms, it is not the source.
 *   5. Entitlement — an unsubscribed module → 402, even with the permission (P8).
 *   6. Permission  — 403.
 *
 * Step 5 precedes 6 deliberately: "your plan does not include this module" is
 * something a customer can act on; "access denied" is not.
 */
export function defineRoute(
  routeId: RouteId,
  handler: AuthedHandler,
): (req: Request, nextCtx?: NextRouteContext) => Promise<Response> {
  return build(routeId, handler, false);
}

/**
 * The variant for paths without authentication.
 *
 * Being public is stated in two places — in the manifest and here — and the two
 * are cross-checked when the module loads. That redundancy is deliberate: one
 * file that is forgotten fails loudly at startup rather than silently exposing
 * an endpoint or locking one that should be open.
 */
export function definePublicRoute(
  routeId: RouteId,
  handler: PublicHandler,
): (req: Request, nextCtx?: NextRouteContext) => Promise<Response> {
  return build(routeId, handler, true);
}

function build(
  routeId: RouteId,
  handler: AuthedHandler | PublicHandler,
  declaredPublic: boolean,
): (req: Request, nextCtx?: NextRouteContext) => Promise<Response> {
  const rule: RouteRule | undefined = ROUTE_MANIFEST[routeId];

  if (!rule) {
    throw new Error(`Route "${routeId}" tidak terdaftar di ROUTE_MANIFEST.`);
  }
  if ((rule.public === true) !== declaredPublic) {
    throw new Error(
      `Route "${routeId}": manifest menyatakan public=${rule.public === true}, ` +
        `tetapi handler memakai ${declaredPublic ? 'definePublicRoute' : 'defineRoute'}.`,
    );
  }

  // A value already proven present, captured as a const so its type narrowing
  // survives inside the nested function below. Without this, TypeScript would
  // consider it possibly `undefined` again — and a `rule!` at every use would
  // hide the real mistake if someone later removed the check above.
  const routeRule = rule;

  return async function route(req: Request, nextCtx?: NextRouteContext): Promise<Response> {
    const ctx = contextFrom(req);
    const params = (await nextCtx?.params) ?? {};

    /**
     * All handling runs inside the request context.
     *
     * One wrapper at this boundary replaces passing `correlationId` as a
     * parameter through dozens of domain functions that have nothing to do with
     * logging — and that would be forgotten in the next function somebody writes.
     *
     * What flows through the context is for LOGGING only. The tenant, as the
     * basis of isolation, is still passed explicitly to `withTenant`, because
     * authorisation that reads implicit state can leak across requests when one
     * `await` goes unawaited.
     */
    return runWithContext({ correlationId: ctx.correlationId, routeId }, () =>
      handleRequest(req, ctx, params),
    );
  };

  async function handleRequest(
    req: Request,
    ctx: ReturnType<typeof contextFrom>,
    params: Record<string, string>,
  ): Promise<Response> {

    if (routeRule.rateLimit) {
      const allowed = await consumeRateLimit(
        `${routeId}:${ctx.ip ?? 'unknown'}`,
        routeRule.rateLimit.max,
        routeRule.rateLimit.windowSeconds,
      );
      if (!allowed) {
        return fail(
          429,
          ErrorCode.RATE_LIMITED,
          'Terlalu banyak permintaan. Coba lagi beberapa saat.',
          ctx.correlationId,
        );
      }
    }

    if (declaredPublic) {
      // A public path needs the same error net as an authenticated one. Without
      // it, one unexpected throw escapes as Next's raw 500 — with no
      // correlationId, and in a response shape different from every other API.
      // Found during the first end-to-end test, not by reasoning.
      try {
        return await (handler as PublicHandler)(req, { ...ctx, params });
      } catch (error) {
        log.error({ scope: 'route', correlationId: ctx.correlationId, routeId, error });
        return fail(500, ErrorCode.INTERNAL, 'Terjadi kesalahan pada sistem', ctx.correlationId);
      }
    }

    const authorization = req.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return fail(401, ErrorCode.TOKEN_INVALID, 'Token akses tidak ada', ctx.correlationId);
    }

    const bearer = authorization.slice(7);

    /**
     * The remote topology (PLAN/14 stage 6).
     *
     * With `AUTH_SERVICE_URL` set, the backend does not verify tokens and does
     * not resolve permissions. It asks. That is the whole shape of the split:
     * exactly one component holds the signing key and exactly one decides what a
     * token means.
     *
     * Two branches rather than one code path, deliberately. In the in-process
     * topology the authorization decision and the handler share ONE transaction;
     * forcing the remote shape onto it would open a second connection per
     * request to buy a uniformity nobody benefits from. The topologies genuinely
     * differ, and pretending they do not would make the default deployment pay
     * for the other one.
     */
    if (authServiceUrl()) {
      const outcome = await authorizeRemotely(
        bearer,
        routeRule.module,
        routeRule.permission,
        ctx.correlationId,
      );

      if (outcome.kind === 'rejected') {
        return fail(
          401,
          outcome.expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
          outcome.expired ? 'Token akses kedaluwarsa' : 'Token akses tidak sah',
          ctx.correlationId,
        );
      }

      if (outcome.kind === 'unavailable') {
        /**
         * Refusal, never a fallback to deciding locally.
         *
         * The backend could resolve permissions itself here — it still shares a
         * database with auth in this topology — and that is exactly why it must
         * not. A second implementation of the authorization decision, running
         * only during incidents, is a second implementation nobody has tested,
         * diverging quietly from the one that normally runs. Risk S3.
         */
        const response = fail(
          AUTH_UNAVAILABLE_STATUS,
          ErrorCode.INTERNAL,
          'Layanan autentikasi sedang tidak dapat dihubungi. Coba lagi sebentar lagi.',
          ctx.correlationId,
        );
        response.headers.set('retry-after', '5');
        return response;
      }

      const remote = outcome.decision;

      // The same header check as below. It is repeated rather than hoisted
      // because in this branch the tenant comes from the auth service, and a
      // check written once against `claims` would be checking a value this
      // branch never produced.
      const remoteHeaderTenant = req.headers.get('x-tenant-id');
      if (remoteHeaderTenant !== null && remoteHeaderTenant !== remote.tenantId) {
        return fail(
          403,
          ErrorCode.TENANT_MISMATCH,
          'Header X-Tenant-ID tidak cocok dengan sesi',
          ctx.correlationId,
        );
      }

      const remoteQuota = await consumeTenantQuota(remote.tenantId);
      if (!remoteQuota.allowed) {
        const response = fail(
          429,
          ErrorCode.RATE_LIMITED,
          `Permintaan dari organisasi Anda melebihi ${TENANT_QUOTA_MAX} per menit. ` +
            'Coba lagi sebentar lagi.',
          ctx.correlationId,
        );
        response.headers.set('retry-after', String(remoteQuota.resetSeconds));
        return response;
      }

      if (!remote.allowed) {
        if (remote.reason === 'stale') {
          return fail(
            401,
            ErrorCode.TOKEN_STALE,
            'Hak akses Anda berubah. Token disegarkan otomatis — coba lagi.',
            ctx.correlationId,
          );
        }

        if (remote.reason === 'module') {
          return fail(
            402,
            ErrorCode.MODULE_NOT_SUBSCRIBED,
            `Paket langganan Anda belum mencakup modul "${routeRule.module}"`,
            ctx.correlationId,
          );
        }

        return fail(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Anda tidak memiliki hak akses untuk tindakan ini',
          ctx.correlationId,
        );
      }

      try {
        return await withTenant(remote.tenantId, async (tx) =>
          (handler as AuthedHandler)(req, {
            ...ctx,
            params,
            tx,
            tenantId: remote.tenantId,
            tenantCode: remote.tenantCode,
            userId: remote.userId,
            email: remote.email,
            access: {
              modules: remote.modules,
              permissions: remote.permissions,
              accessVersion: remote.accessVersion,
            },
          }),
        );
      } catch (error) {
        log.error({ scope: 'route', correlationId: ctx.correlationId, routeId, error });
        return fail(500, ErrorCode.INTERNAL, 'Terjadi kesalahan pada sistem', ctx.correlationId);
      }
    }

    let claims;
    try {
      claims = await verifyAccessToken(bearer);
    } catch (error) {
      const expired = error instanceof TokenVerificationError && error.reason === 'expired';
      return fail(
        401,
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? 'Token akses kedaluwarsa' : 'Token akses tidak sah',
        ctx.correlationId,
      );
    }

    // The X-Tenant-ID header is optional, but where present it has to match.
    // Accepting a header that differs from the token — even once, on one path —
    // is how a cross-tenant leak usually happens (risk R15).
    const headerTenant = req.headers.get('x-tenant-id');
    if (headerTenant !== null && headerTenant !== claims.tid) {
      return fail(
        403,
        ErrorCode.TENANT_MISMATCH,
        'Header X-Tenant-ID tidak cocok dengan sesi',
        ctx.correlationId,
      );
    }

    /**
     * The overall per-tenant quota, OUTSIDE the transaction.
     *
     * Checked before `withTenant` deliberately: its entire purpose is stopping
     * one tenant exhausting the database connections, and checking it after a
     * connection is taken consumes the very connection it is meant to protect.
     */
    const quota = await consumeTenantQuota(claims.tid);
    if (!quota.allowed) {
      // Recorded, not merely refused. A badly set limit has to be visible in the
      // logs — not from a customer phoning because their application stopped
      // working at peak hour.
      log.warn({
        scope: 'tenant-quota',
        tenantId: claims.tid,
        routeId,
        max: TENANT_QUOTA_MAX,
        resetSeconds: quota.resetSeconds,
      });

      const response = fail(
        429,
        ErrorCode.RATE_LIMITED,
        `Permintaan dari organisasi Anda melebihi ${TENANT_QUOTA_MAX} per menit. ` +
          'Coba lagi sebentar lagi.',
        ctx.correlationId,
      );
      response.headers.set('retry-after', String(quota.resetSeconds));
      return response;
    }

    try {
      return await withTenant(claims.tid, async (tx) => {
        /**
         * One call, one decision (PLAN/14 stage 4).
         *
         * The staleness check, the subscription check, and the permission check
         * used to be written out here in sequence, interleaved with rate
         * limiting and error shaping. `decideAccess` is the seam: when
         * authorization becomes a call to the auth service (PLAN/14 §5), what
         * changes is that function's implementation, and the mapping from
         * decision to status code below does not move at all.
         *
         * The order of the checks lives with the decision now, where it can be
         * read and tested as one thing. It matters — 402 before 403, staleness
         * before either — and an order spread across a wrapper is an order that
         * drifts.
         */
        const decision = await decideAccess(tx, {
          tenantId: claims.tid,
          userId: claims.sub,
          tokenAccessVersion: claims.av,
          module: routeRule.module,
          permission: routeRule.permission,
        });

        if (!decision.allowed) {
          if (decision.reason === 'stale') {
            /**
             * A 401, because it is an instruction rather than a refusal: the
             * client already refreshes once and retries on 401, the refresh
             * issues a token carrying the current version, and the user sees
             * nothing. A 403 would be a dead end for a valid session.
             *
             * Logged, because this is the mechanism a permission cache will
             * depend on (PLAN/14 §5 option C) and it should be observable
             * before anything relies on it.
             */
            log.info({
              scope: 'access-version',
              tenantId: claims.tid,
              userId: claims.sub,
              routeId,
              tokenVersion: claims.av,
              currentVersion: decision.access.accessVersion,
            });

            return fail(
              401,
              ErrorCode.TOKEN_STALE,
              'Hak akses Anda berubah. Token disegarkan otomatis — coba lagi.',
              ctx.correlationId,
            );
          }

          if (decision.reason === 'module') {
            return fail(
              402,
              ErrorCode.MODULE_NOT_SUBSCRIBED,
              `Paket langganan Anda belum mencakup modul "${routeRule.module}"`,
              ctx.correlationId,
            );
          }

          return fail(
            403,
            ErrorCode.PERMISSION_DENIED,
            'Anda tidak memiliki hak akses untuk tindakan ini',
            ctx.correlationId,
          );
        }

        const access = decision.access;

        return (handler as AuthedHandler)(req, {
          ...ctx,
          params,
          tenantId: claims.tid,
          tenantCode: claims.tenantCode,
          userId: claims.sub,
          email: claims.email,
          access,
          tx,
        });
      });
    } catch (error) {
      /**
       * An exhausted transaction pool is OVERLOAD, not a fault.
       *
       * Found by a flood test: 700 concurrent requests produced 100 quota
       * refusals and 299 errors at 500 reading "Unable to start a transaction in
       * the given time". A per-minute quota limits RATE, not CONCURRENCY — and
       * what exhausts the pool is concurrency.
       *
       * Answering 500 is wrong in two ways at once: clients and proxies do not
       * retry a 500 (they retry a 503 with a `retry-after`), and error monitoring
       * records it as a bug when the system is working exactly as designed — it
       * is full.
       *
       * The queueing itself is already handled by Prisma; what is fixed here is
       * only what is said when that queue is full.
       */
      const overloaded =
        error instanceof Error &&
        /Unable to start a transaction|Timed out fetching a new connection/i.test(
          error.message,
        );

      if (overloaded) {
        log.warn({ scope: 'overload', correlationId: ctx.correlationId, routeId });
        const response = fail(
          503,
          ErrorCode.RATE_LIMITED,
          'Sistem sedang menerima terlalu banyak permintaan sekaligus. Coba lagi sebentar lagi.',
          ctx.correlationId,
        );
        response.headers.set('retry-after', '2');
        return response;
      }

      log.error({ scope: 'route', correlationId: ctx.correlationId, routeId, error });
      return fail(
        500,
        ErrorCode.INTERNAL,
        'Terjadi kesalahan pada sistem',
        ctx.correlationId,
      );
    }
  }
}

export { fail as apiError };
