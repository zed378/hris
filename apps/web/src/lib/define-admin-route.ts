import { log } from '@hrms/observability';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import { verifySuperuserToken, type SuperuserClaims } from '@hrms/core/platform';
import {
  ADMIN_ROUTE_MANIFEST,
  type AdminRouteId,
  type AdminRouteRule,
} from './route-manifest.ts';
import { consumeRateLimit } from '@hrms/cache';

/**
 * Gateway control plane — counterpart to `admin-gateway` (PLAN/07 §2).
 *
 * Deliberately **entirely separate** from `defineRoute`, not branched from it.
 * Two fields sharing one guard function will soon grow an `isAdmin` parameter,
 * and from that point a single boolean slip separates every customer's data
 * from the unauthorised (P11).
 *
 * The heavier differences:
 *   - Token audience `hrms-admin`, signed with a separate key. Tenant tokens
 *     will never pass here, and vice-versa.
 *   - The handler receives `SuperuserClaims`, not a tenant context. No `tx` is
 *     available — admin code literally has no way to call `withTenant()` from here.
 *   - Its database connection is `hrms_platform`, which has no GRANT on
 *     `auth.users`, `iam.*`, or `audit.*`.
 */

export interface AdminContext {
  correlationId: string;
  ip: string | undefined;
  superuser: SuperuserClaims;
}

type AdminHandler = (req: Request, ctx: AdminContext) => Promise<Response>;
type AdminPublicHandler = (
  req: Request,
  ctx: Omit<AdminContext, 'superuser'>,
) => Promise<Response>;

function fail(status: number, code: ErrorCode, message: string, correlationId: string) {
  const body: ApiError = { error: { code, message, correlationId } };
  return NextResponse.json(body, { status });
}

function baseContext(req: Request) {
  return {
    correlationId: req.headers.get('x-correlation-id') ?? randomUUID(),
    ip:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      undefined,
  };
}

function build(
  routeId: AdminRouteId,
  handler: AdminHandler | AdminPublicHandler,
  declaredPublic: boolean,
): (req: Request) => Promise<Response> {
  const rule: AdminRouteRule | undefined = ADMIN_ROUTE_MANIFEST[routeId];
  if (!rule) throw new Error(`Admin route "${routeId}" is not registered.`);
  if ((rule.public === true) !== declaredPublic) {
    throw new Error(`Admin route "${routeId}": public flag does not match the manifest.`);
  }

  return async function route(req: Request): Promise<Response> {
    const base = baseContext(req);

    if (rule.rateLimit) {
      const ok = await consumeRateLimit(
        `admin:${routeId}:${base.ip ?? 'unknown'}`,
        rule.rateLimit.max,
        rule.rateLimit.windowSeconds,
      );
      if (!ok) {
        return fail(429, ErrorCode.RATE_LIMITED, 'Too many requests', base.correlationId);
      }
    }

    try {
      if (declaredPublic) {
        return await (handler as AdminPublicHandler)(req, base);
      }

      const authorization = req.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) {
        return fail(401, ErrorCode.TOKEN_INVALID, 'Admin token not found', base.correlationId);
      }

      const superuser = await verifySuperuserToken(authorization.slice(7)).catch(() => null);
      if (!superuser) {
        return fail(401, ErrorCode.TOKEN_INVALID, 'Invalid admin token', base.correlationId);
      }

      return await (handler as AdminHandler)(req, { ...base, superuser });
    } catch (error) {
      log.error({ scope: 'admin-route', correlationId: base.correlationId, routeId, error });
      return fail(500, ErrorCode.INTERNAL, 'A system error occurred', base.correlationId);
    }
  };
}

export function defineAdminRoute(routeId: AdminRouteId, handler: AdminHandler) {
  return build(routeId, handler, false);
}

export function definePublicAdminRoute(routeId: AdminRouteId, handler: AdminPublicHandler) {
  return build(routeId, handler, true);
}

export { fail as adminError };
