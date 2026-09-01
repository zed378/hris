import { z } from 'zod';
import {
  loginRequestSchema,
  refreshRequestSchema,
  passwordSchema,
  tenantCodeSchema,
  emailSchema,
} from '@hrms/contracts';
import { ROUTE_MANIFEST, type RouteId, type RouteRule } from './route-manifest.ts';

/**
 * The OpenAPI document, GENERATED rather than written.
 *
 * A hand-written API document drifts from its code, and the drift is silent:
 * readers believe the document, not the server, so the day it stops matching is
 * a day nobody notices. This repository already refuses that trade in three
 * other places — `ROUTE_MANIFEST` against the files on disk (P7), the menu
 * against the pages, the RLS coverage against the tables — and this is the same
 * shape.
 *
 * Everything that CAN be derived is derived. The path, the method, whether
 * authentication is required, which permission guards it, and which module owns
 * it all come from `ROUTE_MANIFEST`, which `defineRoute` already refuses to run
 * without. What cannot be derived is prose — what an endpoint is FOR — and that
 * lives in `DOCS` below, with a CI test refusing a manifest route that has no
 * entry.
 *
 * ## Why the schemas are listed here and not read from the handlers
 *
 * A Next.js route module may only export HTTP verbs and route config. Exporting
 * a schema from `route.ts` is refused by the framework, so there is no way to
 * introspect the Zod object a handler validates with. Listing them here is a
 * duplication, and it is the reason the coverage test matters: it cannot detect
 * a schema that has drifted from its handler, only one that is missing entirely.
 *
 * Stated plainly because it is the weak point of this file.
 *
 * ## Two documents, never one
 *
 * The tenant plane and the control plane are separate documents (P11). Merging
 * them would publish the control-plane surface to every tenant administrator who
 * opens the API documentation — a list of exactly the endpoints that manage
 * their subscription and suspend their account.
 */

type Plane = 'tenant' | 'admin';

interface EndpointDoc {
  summary: string;
  description?: string;
  /** Groups the endpoint in the UI. Defaults to the owning module. */
  tag?: string;
  /** The request body schema, for methods that take one. */
  request?: z.ZodType;
  /** The success response schema. Omitted where the endpoint returns no body. */
  response?: z.ZodType;
  /** Path and query parameters that are not derivable from the route id. */
  query?: Array<{ name: string; description: string; required?: boolean }>;
}

/** The token pair every authenticated call carries. */
const tokenResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  tokenType: z.literal('Bearer'),
});

const idResponse = z.object({ id: z.string().uuid() });
const okResponse = z.object({ ok: z.boolean() });

/**
 * The prose half of the document.
 *
 * Deliberately terse. A summary that repeats the path teaches nothing — the
 * useful sentence is the one naming what the endpoint is FOR, or the constraint
 * a caller will otherwise discover by being refused.
 */
export const DOCS: Partial<Record<RouteId, EndpointDoc>> = {
  'POST /api/tenants/register': {
    summary: 'Mendaftarkan tenant baru beserta pemilik pertamanya',
    description:
      'Satu-satunya jalur yang membuat tenant. Dibatasi laju ketat: pendaftaran ' +
      'tanpa batas adalah cara termurah membanjiri basis data dengan tenant palsu.',
    request: z.object({
      tenantCode: tenantCodeSchema,
      tenantName: z.string(),
      email: emailSchema,
      password: passwordSchema,
      fullName: z.string(),
    }),
  },
  'POST /api/auth/login': {
    summary: 'Menukar kredensial dengan access token',
    description:
      'Refresh token TIDAK ikut di badan balasan. Ia hanya hidup sebagai cookie ' +
      'httpOnly, sehingga JavaScript halaman tidak pernah memegangnya dan karena ' +
      'itu tidak dapat menyimpannya ke tempat yang bertahan (PLAN/11 §5.3).',
    request: loginRequestSchema,
    response: tokenResponse,
  },
  'POST /api/auth/refresh': {
    summary: 'Memperbarui access token memakai cookie refresh',
    description:
      'Refresh token dirotasi pada setiap pemakaian. Token yang sudah digantikan ' +
      'lalu dipakai lagi adalah indikasi pencurian, dan dijawab TOKEN_REUSE_DETECTED.',
    request: refreshRequestSchema.partial(),
    response: tokenResponse,
  },
  'POST /api/auth/logout': { summary: 'Mengakhiri sesi dan menghapus cookie refresh' },
  'POST /api/auth/password/forgot': {
    summary: 'Meminta tautan atur ulang kata sandi',
    description:
      'Selalu 204, termasuk untuk alamat yang tidak terdaftar. Balasan yang ' +
      'membedakan keduanya mengubah endpoint ini menjadi alat pencacah alamat ' +
      'surel karyawan sebuah perusahaan.',
    request: z.object({ tenantCode: tenantCodeSchema, email: emailSchema }),
  },
  'POST /api/auth/password/reset': {
    summary: 'Menetapkan kata sandi baru dengan token dari surel',
    request: z.object({ token: z.string(), newPassword: passwordSchema }),
  },
  'POST /api/auth/invitation/accept': {
    summary: 'Menerima undangan dan menetapkan kata sandi pertama',
    request: z.object({ token: z.string(), password: passwordSchema }),
  },
  'GET /api/health': { summary: 'Liveness — apakah proses ini hidup' },
  'GET /api/ready': {
    summary: 'Readiness — apakah instance ini layak menerima lalu lintas',
    description:
      'Berbeda tujuan dari /api/health. Readiness memutuskan apakah lalu lintas ' +
      'DIALIRKAN ke sini; liveness memutuskan apakah prosesnya DIBUNUH.',
  },
  'GET /api/metrics': {
    summary: 'Metrik Prometheus',
    description:
      'Menjawab 404 kecuali METRICS_TOKEN dipasang, dan 404 juga untuk token ' +
      'yang salah. Hanya metrik teknis — tidak ada pengenal tenant di mana pun.',
  },
  'GET /api/.well-known/jwks.json': {
    summary: 'Kunci publik untuk memverifikasi access token',
    description:
      'Publik menurut definisinya. Kunci publik memungkinkan verifikasi tanda ' +
      'tangan tanpa kemampuan membuatnya (PLAN/14 §6).',
  },
  'GET /api/openapi.json': {
    summary: 'Dokumen OpenAPI ini sendiri',
    description: 'Membutuhkan izin core.settings.manage.',
  },
  'GET /api/dashboard': { summary: 'Ringkasan dasbor, dicakup oleh izin pemanggil' },
  'GET /api/dashboard/trends': {
    summary: 'Tren bulanan enam bulan terakhir',
    query: [{ name: 'months', description: 'Jumlah bulan, 1–24. Default 6.' }],
  },
};

/** The schema shared by every error this API returns. */
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().uuid(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `io: 'input'` describes what a caller SENDS. Without it a schema carrying
  // defaults or transforms is documented as its parsed output, and a caller
  // following the document omits a field the server requires.
  const generated = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
  delete generated['$schema'];
  return generated;
}

function jsonBody(schema: z.ZodType): Record<string, unknown> {
  return { content: { 'application/json': { schema: jsonSchema(schema) } } };
}

/**
 * Splits a route id into its method and path, converting `[id]` to `{id}`.
 *
 * The manifest uses Next's own bracket syntax because that is what the
 * filesystem uses and the P7 coverage test compares the two directly. OpenAPI
 * wants braces.
 */
function parseRouteId(routeId: string): { method: string; path: string; params: string[] } {
  const [method = 'GET', rawPath = '/'] = routeId.split(' ');
  const params = [...rawPath.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
  return { method: method.toLowerCase(), path: rawPath.replace(/\[([^\]]+)\]/g, '{$1}'), params };
}

/**
 * The responses every guarded endpoint can produce, from the gateway rather than
 * from the handler.
 *
 * These are the four a caller will actually meet and be unable to explain, and
 * the order they are checked in carries meaning: 402 before 403, because "your
 * plan does not include this module" is something a customer can act on and
 * "access denied" is not.
 */
function gatewayResponses(rule: RouteRule): Record<string, unknown> {
  if (rule.public) {
    return {
      '400': { description: 'Permintaan tidak sah', ...jsonBody(errorSchema) },
      '429': { description: 'Melebihi batas laju', ...jsonBody(errorSchema) },
    };
  }

  return {
    '401': {
      description:
        'Token tidak ada, tidak sah, kedaluwarsa (TOKEN_EXPIRED), atau basi ' +
        'karena hak akses berubah (TOKEN_STALE). Klien menyegarkan lalu mengulang.',
      ...jsonBody(errorSchema),
    },
    '402': {
      description: `Tenant tidak berlangganan modul "${rule.module}" (P8).`,
      ...jsonBody(errorSchema),
    },
    '403': {
      description: rule.permission
        ? `Tidak memegang izin ${rule.permission} (P9).`
        : 'Header X-Tenant-ID tidak cocok dengan sesi.',
      ...jsonBody(errorSchema),
    },
    '429': { description: 'Melebihi kuota tenant', ...jsonBody(errorSchema) },
  };
}

export interface OpenApiOptions {
  plane: Plane;
  manifest?: Readonly<Record<string, RouteRule>>;
  version?: string;
}

export function buildOpenApiDocument({
  plane,
  manifest = ROUTE_MANIFEST as Readonly<Record<string, RouteRule>>,
  version = '0.0.0',
}: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [routeId, rule] of Object.entries(manifest)) {
    const { method, path, params } = parseRouteId(routeId);
    const doc = DOCS[routeId as RouteId];

    const operation: Record<string, unknown> = {
      summary: doc?.summary ?? routeId,
      operationId: routeId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, ''),
      tags: [doc?.tag ?? rule.module],
      // Written into the document rather than left to prose: a reader needs to
      // know which permission to grant before they can use an endpoint, and it
      // is the single most common reason a call is refused.
      description: [
        doc?.description,
        rule.public
          ? '**Tanpa autentikasi.**'
          : `**Izin:** ${rule.permission ?? 'cukup terautentikasi'}`,
        rule.rateLimit
          ? `**Batas laju:** ${rule.rateLimit.max} per ${rule.rateLimit.windowSeconds} detik, per alamat.`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
      security: rule.public ? [] : [{ bearerAuth: [] }],
      responses: {
        [method === 'post' ? '201' : '200']: doc?.response
          ? { description: 'Berhasil', ...jsonBody(doc.response) }
          : { description: 'Berhasil' },
        ...gatewayResponses(rule),
      },
    };

    const parameters = [
      ...params.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      })),
      ...(doc?.query ?? []).map((q) => ({
        name: q.name,
        in: 'query',
        required: q.required ?? false,
        description: q.description,
        schema: { type: 'string' },
      })),
    ];

    if (parameters.length > 0) operation['parameters'] = parameters;
    if (doc?.request) operation['requestBody'] = { required: true, ...jsonBody(doc.request) };

    paths[path] ??= {};
    paths[path][method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: plane === 'tenant' ? 'HRMS — Tenant API' : 'HRMS — Control Plane API',
      version,
      description:
        plane === 'tenant'
          ? 'API bidang tenant. Setiap permintaan terikat pada satu tenant lewat klaim ' +
            '`tid` di dalam token; header X-Tenant-ID boleh dikirim tetapi hanya ' +
            'MENGONFIRMASI, tidak pernah menjadi sumbernya.\n\n' +
            'Dokumen ini digenerate dari ROUTE_MANIFEST dan skema Zod yang ' +
            'benar-benar dipakai server, bukan ditulis terpisah.'
          : 'API control plane. Audience token berbeda (`hrms-admin`) dan tidak ' +
            'pernah diterima gateway tenant (P11).',
    },
    servers: [{ url: '/', description: 'Origin yang sama dengan aplikasi' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            plane === 'tenant'
              ? 'Access token dari POST /api/auth/login. Berumur 15 menit.'
              : 'Access token dari POST /admin/api/auth/login. Wajib TOTP.',
        },
      },
      schemas: { Error: jsonSchema(errorSchema) },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

export { okResponse, idResponse };
