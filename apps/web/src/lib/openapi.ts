import { z } from 'zod';
import {
  loginRequestSchema,
  refreshRequestSchema,
  passwordSchema,
  tenantCodeSchema,
  emailSchema,
  ErrorReason,
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
    summary: 'Registers a new tenant with its first owner',
    description:
      'The only path that creates a tenant. Tightly rate-limited: unlimited ' +
      'registration is the cheapest way to flood the database with fake tenants.',
    request: z.object({
      tenantCode: tenantCodeSchema,
      tenantName: z.string(),
      email: emailSchema,
      password: passwordSchema,
      fullName: z.string(),
    }),
  },
  'POST /api/auth/login': {
    summary: 'Exchanges credentials for an access token',
    description:
      'The refresh token is NOT in the response body. It lives only in an ' +
      'httpOnly cookie, so page JavaScript never holds it and cannot persist it ' +
      '(docs/PLAN/11 §5.3). Every failure is one INVALID_CREDENTIALS with no reason.',
    request: loginRequestSchema,
    response: tokenResponse,
  },
  'POST /api/auth/refresh': {
    summary: 'Renews the access token using the refresh cookie',
    description:
      'The refresh token rotates on every use. A token that was already replaced ' +
      'and is used again indicates theft, and is answered TOKEN_REUSE_DETECTED.',
    request: refreshRequestSchema.partial(),
    response: tokenResponse,
  },
  'POST /api/auth/logout': { summary: 'Ends the session and clears the refresh cookie' },
  'POST /api/auth/password/forgot': {
    summary: 'Requests a password reset link',
    description:
      'Always 204, including for an address that is not registered. A reply ' +
      'telling the two apart turns this endpoint into a tool for enumerating a ' +
      'company\'s employee email addresses.',
    request: z.object({ tenantCode: tenantCodeSchema, email: emailSchema }),
  },
  'POST /api/auth/password/reset': {
    summary: 'Sets a new password with the token from the email',
    description: 'An invalid, expired, or used token is TOKEN_INVALID with reason ACTION_TOKEN_INVALID.',
    request: z.object({ token: z.string(), newPassword: passwordSchema }),
  },
  'POST /api/auth/invitation/accept': {
    summary: 'Accepts an invitation and sets the first password',
    description: 'An invalid, expired, or used token is TOKEN_INVALID with reason ACTION_TOKEN_INVALID.',
    request: z.object({ token: z.string(), password: passwordSchema }),
  },
  'GET /api/health': { summary: 'Liveness — whether this process is alive' },
  'GET /api/ready': {
    summary: 'Readiness — whether this instance should receive traffic',
    description:
      'A different purpose from /api/health. Readiness decides whether traffic is ' +
      'ROUTED here; liveness decides whether the process is KILLED.',
  },
  'GET /api/metrics': {
    summary: 'Prometheus metrics',
    description:
      'Answers 404 unless METRICS_TOKEN is set, and 404 for a wrong token too. ' +
      'Technical metrics only — no tenant identifier anywhere.',
  },
  'GET /api/.well-known/jwks.json': {
    summary: 'Public keys for verifying access tokens',
    description:
      'Public by definition. A public key allows verifying a signature without ' +
      'the ability to create one (docs/PLAN/14 §6).',
  },
  'GET /api/openapi.json': {
    summary: 'This OpenAPI document',
    description: 'Requires core.settings.manage.',
  },
  'GET /api/dashboard': { summary: 'Dashboard summary, scoped by the caller\'s permissions' },
  'GET /api/dashboard/trends': {
    summary: 'Monthly trends over the last six months',
    query: [{ name: 'months', description: 'Number of months, 1–24. Default 6.' }],
  },

  // Each summary was written from the handler, not the path (P6-18.2).
  'GET /api/users': { summary: 'Lists the tenant\'s users with their roles and last login' },
  'POST /api/users': {
    summary: 'Invites a user by email; they set their own password',
    description: 'The user, the invitation token, and the event that sends the email are written in one transaction. The assigned role is subject to the permission ceiling (403 PERMISSION_CEILING, ADR-035).',
  },
  'POST /api/users/from-employees': {
    summary: 'Invites employees who have no account yet, in bulk',
    description: 'Employees without an email are reported, not failed; those with an account already are skipped. Up to 500 per call. The role is subject to the permission ceiling, checked once for the whole call.',
  },
  'PUT /api/users/[id]/grants': {
    summary: 'Grants or denies one permission to one user, outside their roles',
    description: 'DENY always wins over roles and GRANTs. A reason of at least 8 characters is required. A GRANT is subject to the permission ceiling; nobody but the owner may change an owner\'s grants.',
  },
  'DELETE /api/users/[id]/grants': {
    summary: 'Removes a per-user GRANT or DENY',
    description: 'Lifting a DENY restores the permission, so it is subject to the permission ceiling.',
  },
  'GET /api/roles': { summary: 'Lists roles with their permissions, and the permission catalogue' },
  'GET /api/audit': { summary: 'Reads the tenant audit trail' },
  'PUT /api/roles/[id]/permissions': {
    summary: 'Replaces a role\'s whole permission set',
    description: 'PUT, not PATCH: the role matrix is saved whole. Added permissions are subject to the permission ceiling; only the owner may change TENANT_OWNER. Every holder\'s access version is bumped in the same transaction.',
  },
  'GET /api/employees': {
    summary: 'Lists employees; identifiers are masked unless the caller may unmask them',
    description: 'An unmasked read writes an `employee.pii.unmasked` audit row.',
  },
  'POST /api/employees': { summary: 'Creates an employee' },
  'GET /api/employees/[id]': {
    summary: 'Reads one employee; identifiers are masked unless the caller may unmask them',
    description: 'An unmasked read writes an `employee.pii.unmasked` audit row.',
  },
  'PATCH /api/employees/[id]': { summary: 'Updates an employee' },
  'PATCH /api/employees/bulk': {
    summary: 'Saves many employee edits from the grid, each row in its own transaction',
    description: 'One invalid row does not discard the others; the response reports each row\'s outcome.',
  },
  'GET /api/employees/[id]/documents': { summary: 'Lists an employee\'s documents' },
  'POST /api/employees/[id]/documents': {
    summary: 'Uploads an employee document',
    description: 'The file type is decided from the file\'s contents, not its declared content type.',
  },
  'GET /api/documents/[docId]': {
    summary: 'Serves a document\'s contents',
    description: 'An employee may read their own documents; reading another\'s requires `employee.document.read`.',
  },
  'DELETE /api/documents/[docId]': {
    summary: 'Archives a document',
    description: 'The file is removed; the database row is kept as the record that it existed.',
  },
  'GET /api/employees/template': { summary: 'Downloads the .xlsx import template with example rows' },
  'GET /api/employees/export': {
    summary: 'Exports employees as .xlsx with the on-screen filters',
    description: 'Identifiers are masked unless the caller may unmask them; every export is audited.',
  },
  'GET /api/contracts/expiring': {
    summary: 'Lists contracts ending soon, including those already past',
    description: 'Past contracts carry a negative `daysLeft`.',
  },
  'POST /api/contracts': { summary: 'Records an employment contract' },
  'POST /api/employees/import': { summary: 'Uploads an import file and returns a preview; saves nothing' },
  'GET /api/employees/import/[id]': { summary: 'Reads an import preview and its row errors' },
  'POST /api/employees/import/[id]/commit': {
    summary: 'Saves the valid rows of an import preview',
    description: 'Idempotent: a preview already committed is refused.',
  },
  'GET /api/org/departments': { summary: 'Lists departments' },
  'POST /api/org/departments': { summary: 'Creates a department' },
  'GET /api/org/positions': { summary: 'Lists positions' },
  'POST /api/org/positions': { summary: 'Creates a position' },
  'POST /api/org/placements': {
    summary: 'Places or transfers an employee',
    description: 'History is never overwritten (P13): the current period is closed the day before and a new one begins.',
  },
  'POST /api/attendance/punch': {
    summary: 'Records the caller\'s own punch with its evidence',
    description: 'The employee is derived from the session, never the body. Evidence is scored, never auto-rejected (P14); a low score routes the punch to review.',
  },
  'GET /api/attendance/me': { summary: 'Reads the caller\'s own attendance, with all its evidence' },
  'POST /api/attendance/photo': {
    summary: 'Uploads a punch photo through the server',
    description: 'EXIF metadata, including location, is stripped on the server before storage.',
  },
  'GET /api/attendance/photo/[key]': {
    summary: 'Serves a punch photo',
    description: 'An employee may see their own; others require `attendance.review.handle`. Every access is logged.',
  },
  'GET /api/attendance/review': { summary: 'Lists flagged punches awaiting review' },
  'POST /api/attendance/review': { summary: 'Accepts or rejects a flagged punch' },
  'GET /api/subscription': { summary: 'Reads the tenant\'s plan and enabled modules' },
  'GET /api/tenant/export': {
    summary: 'Exports all of the tenant\'s data (portability)',
    description: 'Identifiers are included unmasked only for a caller holding `employee.pii.unmask`.',
  },
  'POST /api/subscription': { summary: 'Enables or disables a module within the tenant\'s plan' },
  'GET /api/payroll/components': { summary: 'Lists salary components with the variables and functions formulas may use' },
  'POST /api/payroll/components': { summary: 'Creates or updates a salary component' },
  'PUT /api/payroll/components': { summary: 'Validates a formula without saving it' },
  'GET /api/payroll/salary': { summary: 'Reads an employee\'s salary structure with its full history' },
  'POST /api/payroll/salary': {
    summary: 'Starts a new salary structure period',
    description: 'Structures are period-based; a new one closes the previous period rather than changing it (P13).',
  },
  'GET /api/payroll/runs': { summary: 'Lists payroll runs' },
  'GET /api/payroll/runs/export': {
    summary: 'Exports one run\'s payslips as .xlsx for bank bulk transfer',
    description: 'Account numbers are masked unless the caller may unmask them.',
  },
  'POST /api/payroll/runs': {
    summary: 'Creates a payroll run for a period',
    description: 'A duplicate run for the same period is refused by a partial unique index.',
  },
  'GET /api/payroll/runs/[id]': { summary: 'Reads one payroll run and its payslips' },
  'POST /api/payroll/runs/[id]': {
    summary: 'Calculates, approves, or cancels a run',
    description: 'Calculation skips payslips that already exist, so an interrupted run resumes.',
  },
  'GET /api/payroll/payslips': {
    summary: 'Reads payslips with their calculation trace',
    description: 'An employee sees their own; others require `payroll.payslip.read.all`.',
  },
  'GET /api/notifications/subscriptions': { summary: 'Lists the caller\'s Web Push subscriptions' },
  'POST /api/notifications/subscriptions': { summary: 'Registers a Web Push subscription for the caller' },
  'DELETE /api/notifications/subscriptions': { summary: 'Removes one of the caller\'s Web Push subscriptions' },
  'GET /api/leave/types': { summary: 'Lists active leave types' },
  'POST /api/leave/types': { summary: 'Creates or updates a leave type' },
  'GET /api/leave/approvers': {
    summary: 'Lists who may be nominated to approve the caller\'s leave',
    description: 'Only holders of `leave.request.approve`, excluding the caller.',
  },
  'GET /api/leave/requests': { summary: 'Lists leave requests in the caller\'s scope (own, team, or all)' },
  'GET /api/leave/requests/export': { summary: 'Exports a year\'s leave requests as .xlsx' },
  'POST /api/leave/requests': {
    summary: 'Requests leave for oneself and holds the balance',
    description: 'The employee is derived from the session. The nominated approver must hold `leave.request.approve` (409 otherwise).',
  },
  'POST /api/leave/requests/[id]/decision': {
    summary: 'Approves or rejects a leave request',
    description: 'Self-approval is refused without exception (403). Someone other than the nominated approver may decide, and that substitution is recorded.',
  },
  'DELETE /api/leave/requests/[id]/decision': { summary: 'Cancels one\'s own undecided request' },
  'POST /api/leave/attachments': {
    summary: 'Uploads a leave attachment such as a doctor\'s note',
    description: 'Health data: stored on the caller\'s own behalf, and claimable by one request only.',
  },
  'GET /api/leave/attachments/[key]': {
    summary: 'Serves a leave attachment',
    description: 'Health data: the requester and holders of `leave.request.read.all` only; anyone else gets 404, so its existence is not disclosed. Every access is audited.',
  },
  'GET /api/leave/balances': { summary: 'Reads leave balances, the caller\'s own unless `employeeId` is given' },
  'POST /api/leave/balances': {
    summary: 'Adjusts a leave balance manually',
    description: 'Always written to the ledger and audited.',
  },
  'GET /api/attendance/live': {
    summary: 'Streams who is in, late, or absent today (Server-Sent Events)',
    description: 'No coordinates appear on team views (P15).',
  },
  'GET /api/attendance/consent': { summary: 'Reads the caller\'s location and photo consent' },
  'POST /api/attendance/consent': { summary: 'Grants or withdraws the caller\'s location or photo consent' },
  'POST /api/attendance/device-import': {
    summary: 'Imports punches from an attendance machine export',
    description: '`commit=false` parses and previews; `commit=true` saves.',
  },
  'POST /api/attendance/manual-punch': {
    summary: 'Records a punch entered by HR on an employee\'s behalf',
    description: 'Always audited, with the reason.',
  },
  'GET /api/attendance/records': { summary: 'Reads all employees\' attendance over a date range' },
  'GET /api/reports/attendance-monthly': { summary: 'Monthly attendance summary, one row per employee' },
  'GET /api/attendance/records/export': {
    summary: 'Exports attendance as .xlsx for an explicit date range',
    description: 'There is no default range covering everything.',
  },
  'POST /api/attendance/records': { summary: 'Recalculates a day or closes an attendance period' },
  'GET /api/attendance/work-sites': { summary: 'Lists work sites' },
  'POST /api/attendance/work-sites': { summary: 'Creates a work site with its geofence' },
  'PATCH /api/attendance/work-sites/[id]': { summary: 'Updates a work site' },
  'GET /api/attendance/policy': {
    summary: 'Reads the tenant\'s attendance policy',
    description: 'Readable by anyone who may punch: the punch screen needs it to know which evidence to ask for.',
  },
  'PUT /api/attendance/policy': { summary: 'Updates the tenant\'s attendance policy' },
  'GET /api/attendance/holidays': { summary: 'Lists public holidays and joint leave days' },
  'POST /api/attendance/holidays': { summary: 'Adds a holiday' },
  'DELETE /api/attendance/holidays': { summary: 'Removes a holiday' },
  'GET /api/attendance/schedules': { summary: 'Reads work schedules over a date range' },
  'POST /api/attendance/schedules': { summary: 'Assigns schedules to employees' },
  'GET /api/attendance/shifts': { summary: 'Lists shifts' },
  'POST /api/attendance/shifts': { summary: 'Creates a shift' },
  'GET /api/me/bootstrap': {
    summary: 'Returns the caller\'s user, tenant, permissions, and menu',
    description: 'The frontend\'s only source for its navigation and route guards. Convenience, not authorization: the gateway checks every endpoint independently (P9).',
  },
};

/** The schema shared by every error this API returns. */
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().uuid(),
    /** Refines `code` where users must be told refusals apart (ADR-037). */
    reason: z.enum(Object.values(ErrorReason) as [ErrorReason, ...ErrorReason[]]).optional(),
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
      '400': { description: 'Invalid request', ...jsonBody(errorSchema) },
      '429': { description: 'Rate limit exceeded', ...jsonBody(errorSchema) },
    };
  }

  return {
    '401': {
      description:
        'Token missing, invalid, expired (TOKEN_EXPIRED), or stale because access ' +
        'changed (TOKEN_STALE). The client refreshes and retries.',
      ...jsonBody(errorSchema),
    },
    '402': {
      description: `The tenant does not subscribe to the "${rule.module}" module (P8).`,
      ...jsonBody(errorSchema),
    },
    '403': {
      description: rule.permission
        ? `The caller does not hold ${rule.permission} (P9).`
        : 'X-Tenant-ID header does not match the session.',
      ...jsonBody(errorSchema),
    },
    '429': { description: 'Tenant quota exceeded', ...jsonBody(errorSchema) },
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
          ? '**No authentication.**'
          : `**Permission:** ${rule.permission ?? 'any authenticated user'}`,
        rule.rateLimit
          ? `**Rate limit:** ${rule.rateLimit.max} per ${rule.rateLimit.windowSeconds} seconds, per address.`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
      security: rule.public ? [] : [{ bearerAuth: [] }],
      responses: {
        [method === 'post' ? '201' : '200']: doc?.response
          ? { description: 'Success', ...jsonBody(doc.response) }
          : { description: 'Success' },
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
          ? 'The tenant-plane API. Every request is bound to one tenant through the ' +
            '`tid` claim in the token; an X-Tenant-ID header may be sent but only ' +
            'CONFIRMS it, never sources it.\n\n' +
            'Errors carry a stable `code` and, where one code covers several ' +
            'refusals, a `reason` (ADR-037). `message` is English for developers ' +
            'and is never shown to users.\n\n' +
            'Generated from ROUTE_MANIFEST and the Zod schemas the server ' +
            'actually uses, not written separately.'
          : 'The control-plane API. A different token audience (`hrms-admin`), never ' +
            'accepted by the tenant gateway (P11).',
    },
    servers: [{ url: '/', description: 'Same origin as the application' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            plane === 'tenant'
              ? 'Access token from POST /api/auth/login. Lives 15 minutes.'
              : 'Access token from POST /admin/api/auth/login. TOTP required.',
        },
      },
      schemas: { Error: jsonSchema(errorSchema) },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

export { okResponse, idResponse };
