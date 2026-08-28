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
  /** Segmen dinamis dari URL, mis. `[id]` pada /api/roles/[id]/permissions. */
  params: Record<string, string>;
}

export interface AuthenticatedContext extends RequestContext, RouteParams {
  tenantId: string;
  tenantCode: string;
  userId: string;
  email: string;
  access: EffectiveAccess;
  /** Transaksi dengan konteks tenant sudah terpasang. RLS berlaku penuh. */
  tx: TenantClient;
}

type PublicHandler = (req: Request, ctx: RequestContext & RouteParams) => Promise<Response>;
type AuthedHandler = (req: Request, ctx: AuthenticatedContext) => Promise<Response>;

/**
 * Argumen kedua yang diberikan Next kepada route handler.
 *
 * `params` berupa Promise sejak Next 15. Diselesaikan di sini sekali, supaya
 * setiap handler menerima objek biasa dan tidak ada yang lupa menunggunya —
 * `params.id` pada sebuah Promise bernilai `undefined`, bukan galat, sehingga
 * kelalaian itu akan lolos diam-diam sampai ke produksi.
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
): (req: Request, nextCtx?: NextRouteContext) => Promise<Response> {
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

  // Nilai yang sudah dipastikan ada, ditangkap sebagai const supaya penyempitan
  // tipenya bertahan di dalam fungsi bersarang di bawah. Tanpa ini, TypeScript
  // kembali menganggapnya mungkin `undefined` — dan `rule!` di setiap
  // penggunaannya akan menyembunyikan kesalahan yang sesungguhnya bila kelak
  // pemeriksaan di atas dihapus orang.
  const routeRule = rule;

  return async function route(req: Request, nextCtx?: NextRouteContext): Promise<Response> {
    const ctx = contextFrom(req);
    const params = (await nextCtx?.params) ?? {};

    /**
     * Seluruh penanganan berjalan di dalam konteks permintaan.
     *
     * Satu pembungkus di batas ini menggantikan penerusan `correlationId`
     * sebagai parameter ke puluhan fungsi domain yang tidak ada urusannya
     * dengan pencatatan — dan yang akan lupa diisi pada fungsi berikutnya yang
     * ditulis orang.
     *
     * Yang mengalir lewat konteks hanya untuk PENCATATAN. Tenant sebagai dasar
     * isolasi tetap diteruskan eksplisit ke `withTenant`, karena otorisasi yang
     * membaca keadaan implisit dapat bocor lintas permintaan ketika satu
     * `await` lupa ditunggu.
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
      // Jalur publik butuh penjaring galat yang sama seperti jalur terautentikasi.
      // Tanpa ini, satu lemparan tak terduga keluar sebagai 500 mentah Next —
      // tanpa correlationId, dan dengan bentuk balasan yang berbeda dari seluruh
      // API lain. Ditemukan saat uji end-to-end pertama, bukan lewat penalaran.
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

    /**
     * Kuota menyeluruh per tenant, DI LUAR transaksi.
     *
     * Diperiksa sebelum `withTenant` dengan sengaja: seluruh gunanya adalah
     * mencegah satu tenant menghabiskan koneksi basis data, dan memeriksanya
     * setelah koneksi diambil justru menghabiskan koneksi yang hendak dijaga.
     */
    const quota = consumeTenantQuota(claims.tid);
    if (!quota.allowed) {
      // Dicatat, bukan hanya ditolak. Batas yang salah setel harus ketahuan
      // dari log — bukan dari pelanggan yang menelepon karena aplikasinya
      // berhenti bekerja pada jam sibuk.
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
       * Pool transaksi habis adalah KELEBIHAN BEBAN, bukan kerusakan.
       *
       * Ditemukan lewat uji banjir: 700 permintaan bersamaan menghasilkan 100
       * penolakan kuota dan 299 galat 500 bertuliskan "Unable to start a
       * transaction in the given time". Kuota per menit membatasi LAJU, bukan
       * KONKURENSI — dan yang menghabiskan pool adalah konkurensi.
       *
       * Membalasnya 500 salah dalam dua hal sekaligus: klien dan proxy tidak
       * mencoba ulang 500 (mereka mencoba ulang 503 dengan `retry-after`), dan
       * pemantauan galat mencatatnya sebagai bug padahal sistemnya berfungsi
       * persis sebagaimana dirancang — ia sedang penuh.
       *
       * Antreannya sendiri sudah ditangani Prisma; yang diperbaiki di sini
       * hanyalah apa yang dikatakan ketika antrean itu penuh.
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
