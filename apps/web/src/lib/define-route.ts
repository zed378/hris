import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { withTenant, type TenantClient } from '@hrms/db';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import { verifyAccessToken, TokenVerificationError } from '@hrms/core/auth';
import { resolveEffectiveAccess, type EffectiveAccess } from '@hrms/core/iam';
import { ROUTE_MANIFEST, type RouteId, type RouteRule } from './route-manifest.ts';
import { consumeRateLimit } from './rate-limit.ts';

export interface RequestContext {
  correlationId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface AuthenticatedContext extends RequestContext {
  tenantId: string;
  tenantCode: string;
  userId: string;
  email: string;
  access: EffectiveAccess;
  /** Transaksi dengan konteks tenant sudah terpasang. RLS berlaku penuh. */
  tx: TenantClient;
}

type PublicHandler = (req: Request, ctx: RequestContext) => Promise<Response>;
type AuthedHandler = (req: Request, ctx: AuthenticatedContext) => Promise<Response>;

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
 * Membungkus setiap handler API dengan rantai keputusan yang sama.
 *
 * Urutannya bukan selera — setiap langkah mengandaikan langkah sebelumnya:
 *
 *   1. Manifest    — route tak terdaftar mengembalikan 404, bukan 500. Endpoint
 *                    yang tak sengaja terekspos tidak pernah dapat dijangkau (P7).
 *   2. Rate limit  — sebelum kerja mahal apa pun (argon2, query).
 *   3. Token       — audience `hrms-tenant`; token superuser gagal di sini (P11).
 *   4. X-Tenant-ID — bila dikirim, WAJIB cocok dengan klaim `tid`. Header tidak
 *                    pernah dipercaya sendirian; ia hanya penegas, bukan sumber.
 *   5. Entitlement — modul tidak dilanggan → 402, meski permission dimiliki (P8).
 *   6. Permission  — 403.
 *
 * Langkah 5 mendahului 6 dengan sengaja: pesan "paket Anda belum mencakup modul
 * ini" dapat ditindaklanjuti pelanggan; "akses ditolak" tidak.
 */
export function defineRoute(
  routeId: RouteId,
  handler: AuthedHandler,
): (req: Request) => Promise<Response> {
  return build(routeId, handler, false);
}

/**
 * Varian untuk jalur tanpa autentikasi.
 *
 * Sifat publik dinyatakan di dua tempat — di manifest dan di sini — dan keduanya
 * dicocokkan saat modul dimuat. Redundansi ini disengaja: satu berkas yang lupa
 * diperbarui akan gagal keras saat startup, bukan diam-diam mengekspos endpoint
 * atau mengunci endpoint yang seharusnya terbuka.
 */
export function definePublicRoute(
  routeId: RouteId,
  handler: PublicHandler,
): (req: Request) => Promise<Response> {
  return build(routeId, handler, true);
}

function build(
  routeId: RouteId,
  handler: AuthedHandler | PublicHandler,
  declaredPublic: boolean,
): (req: Request) => Promise<Response> {
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

  return async function route(req: Request): Promise<Response> {
    const ctx = contextFrom(req);

    if (rule.rateLimit) {
      const allowed = consumeRateLimit(
        `${routeId}:${ctx.ip ?? 'unknown'}`,
        rule.rateLimit.max,
        rule.rateLimit.windowSeconds,
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
      // Jalur publik butuh penjaring galat yang sama seperti jalur terautentikasi.
      // Tanpa ini, satu lemparan tak terduga keluar sebagai 500 mentah Next —
      // tanpa correlationId, dan dengan bentuk balasan yang berbeda dari seluruh
      // API lain. Ditemukan saat uji end-to-end pertama, bukan lewat penalaran.
      try {
        return await (handler as PublicHandler)(req, ctx);
      } catch (error) {
        console.error({ correlationId: ctx.correlationId, routeId, error });
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

    // Header X-Tenant-ID bersifat opsional, tetapi bila ada ia harus cocok.
    // Menerima header yang berbeda dari token — walau sekali, di satu jalur —
    // adalah cara kebocoran lintas-tenant biasanya terjadi (risiko R15).
    const headerTenant = req.headers.get('x-tenant-id');
    if (headerTenant !== null && headerTenant !== claims.tid) {
      return fail(
        403,
        ErrorCode.TENANT_MISMATCH,
        'Header X-Tenant-ID tidak cocok dengan sesi',
        ctx.correlationId,
      );
    }

    try {
      return await withTenant(claims.tid, async (tx) => {
        const access = await resolveEffectiveAccess(tx, claims.tid, claims.sub);

        if (!access.modules.includes(rule.module)) {
          return fail(
            402,
            ErrorCode.MODULE_NOT_SUBSCRIBED,
            `Paket langganan Anda belum mencakup modul "${rule.module}"`,
            ctx.correlationId,
          );
        }

        if (rule.permission !== null && !access.permissions.includes(rule.permission)) {
          return fail(
            403,
            ErrorCode.PERMISSION_DENIED,
            'Anda tidak memiliki hak akses untuk tindakan ini',
            ctx.correlationId,
          );
        }

        return (handler as AuthedHandler)(req, {
          ...ctx,
          tenantId: claims.tid,
          tenantCode: claims.tenantCode,
          userId: claims.sub,
          email: claims.email,
          access,
          tx,
        });
      });
    } catch (error) {
      console.error({ correlationId: ctx.correlationId, routeId, error });
      return fail(
        500,
        ErrorCode.INTERNAL,
        'Terjadi kesalahan pada sistem',
        ctx.correlationId,
      );
    }
  };
}

export { fail as apiError };
