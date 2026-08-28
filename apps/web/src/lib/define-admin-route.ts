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
import { consumeRateLimit } from './rate-limit.ts';

/**
 * Gateway control plane — padanan `admin-gateway` (PLAN/07 §2).
 *
 * Sengaja **terpisah total** dari `defineRoute`, bukan bercabang di dalamnya.
 * Dua bidang yang berbagi satu fungsi guard akan cepat menumbuhkan parameter
 * `isAdmin`, dan sejak saat itu satu kekeliruan boolean memisahkan data seluruh
 * pelanggan dari orang yang tidak berhak (P11).
 *
 * Perbedaan yang menanggung beban:
 *   - Audience token `hrms-admin`, ditandatangani dengan rahasia berbeda. Token
 *     tenant tidak akan pernah lolos di sini, dan sebaliknya.
 *   - Handler menerima `SuperuserClaims`, bukan konteks tenant. Tidak ada `tx`
 *     ber-konteks yang tersedia — kode admin secara harfiah tidak punya cara
 *     memanggil `withTenant()` dari sini.
 *   - Koneksi basis datanya `hrms_platform`, yang tidak memiliki GRANT ke
 *     `auth.users`, `iam.*`, maupun `audit.*`.
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
  if (!rule) throw new Error(`Route admin "${routeId}" tidak terdaftar.`);
  if ((rule.public === true) !== declaredPublic) {
    throw new Error(`Route admin "${routeId}": sifat publik tidak cocok dengan manifest.`);
  }

  return async function route(req: Request): Promise<Response> {
    const base = baseContext(req);

    if (rule.rateLimit) {
      const ok = consumeRateLimit(
        `admin:${routeId}:${base.ip ?? 'unknown'}`,
        rule.rateLimit.max,
        rule.rateLimit.windowSeconds,
      );
      if (!ok) {
        return fail(429, ErrorCode.RATE_LIMITED, 'Terlalu banyak permintaan', base.correlationId);
      }
    }

    try {
      if (declaredPublic) {
        return await (handler as AdminPublicHandler)(req, base);
      }

      const authorization = req.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) {
        return fail(401, ErrorCode.TOKEN_INVALID, 'Token admin tidak ada', base.correlationId);
      }

      const superuser = await verifySuperuserToken(authorization.slice(7)).catch(() => null);
      if (!superuser) {
        return fail(401, ErrorCode.TOKEN_INVALID, 'Token admin tidak sah', base.correlationId);
      }

      return await (handler as AdminHandler)(req, { ...base, superuser });
    } catch (error) {
      log.error({ scope: 'admin-route', correlationId: base.correlationId, routeId, error });
      return fail(500, ErrorCode.INTERNAL, 'Terjadi kesalahan pada sistem', base.correlationId);
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
