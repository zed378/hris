import { log, runWithContext } from '@hrms/observability';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { withTenant, type TenantClient } from '@hrms/db';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import { verifyAccessToken, TokenVerificationError } from '@hrms/core/auth';
import { resolveEffectiveAccess, type EffectiveAccess } from '@hrms/core/iam';
import { ROUTE_MANIFEST, type RouteId, type RouteRule } from './route-manifest.ts';
import { consumeRateLimit, consumeTenantQuota, TENANT_QUOTA_MAX } from './rate-limit.ts';

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
      const allowed = consumeRateLimit(
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

    let claims;
    try {
      claims = await verifyAccessToken(authorization.slice(7));
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
    const quota = consumeTenantQuota(claims.tid);
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
        const access = await resolveEffectiveAccess(tx, claims.tid, claims.sub);

        /**
         * The token's access version must match the recorded one (PLAN/14 §5).
         *
         * `av` has been minted into every access token since tokens existed. Its
         * comment described the gateway comparing it against the stored version
         * and rejecting stale tokens. **No such comparison existed anywhere** —
         * the claim was issued, validated for shape, and read by nothing.
         *
         * It was harmless while access is resolved from the database on every
         * request, because then the permissions in force are always current and
         * the version has nothing to invalidate. It stops being harmless the
         * moment a permission CACHE exists, which is exactly what the auth split
         * needs to avoid a remote call per request (PLAN/14 §5, option C). At
         * that point this comparison is the ONLY thing that makes a cached
         * permission safe to trust — and a mechanism first exercised on the day
         * it becomes load-bearing is a mechanism nobody has ever seen work.
         *
         * So it is enforced now, while the correct behaviour is still observable
         * without it.
         *
         * ## Why 401 and not 403
         *
         * Because it is not a refusal, it is an instruction: the token is out of
         * date, and the client already knows what to do with a 401 — refresh once
         * and retry. The refresh issues a token carrying the current version, the
         * retry succeeds, and the user sees nothing. A 403 would be a dead end
         * for a session that is perfectly valid.
         *
         * ## Why any difference, not just a lower version
         *
         * A token whose version is HIGHER than the record should be impossible.
         * When it happens the record has moved backwards — a restored backup, a
         * botched migration — and the safe reading is that we no longer know what
         * this user is entitled to. Refreshing re-derives it from the current
         * state, which is the only thing here that can be trusted.
         */
        if (claims.av !== access.accessVersion) {
          log.info({
            scope: 'access-version',
            tenantId: claims.tid,
            userId: claims.sub,
            routeId,
            tokenVersion: claims.av,
            currentVersion: access.accessVersion,
          });

          return fail(
            401,
            ErrorCode.TOKEN_STALE,
            'Hak akses Anda berubah. Token disegarkan otomatis — coba lagi.',
            ctx.correlationId,
          );
        }

        if (!access.modules.includes(routeRule.module)) {
          return fail(
            402,
            ErrorCode.MODULE_NOT_SUBSCRIBED,
            `Paket langganan Anda belum mencakup modul "${routeRule.module}"`,
            ctx.correlationId,
          );
        }

        if (routeRule.permission !== null && !access.permissions.includes(routeRule.permission)) {
          return fail(
            403,
            ErrorCode.PERMISSION_DENIED,
            'Anda tidak memiliki hak akses untuk tindakan ini',
            ctx.correlationId,
          );
        }

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
