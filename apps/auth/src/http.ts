import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode, ApiError } from '@hrms/contracts';

/**
 * The small amount of HTTP this service needs (PLAN/14 stage 6).
 *
 * Written against `node:http` rather than a framework, and that is a decision
 * rather than an omission. This service has nine endpoints and is the one
 * component holding password hashes and the token signing key; every dependency
 * it takes is a dependency inside that blast radius. Express or Fastify would
 * bring a tree of transitive packages to save perhaps eighty lines that are all
 * visible below.
 *
 * The error envelope is byte-for-byte the one the backend returns. A client
 * cannot tell which service refused it, and should not have to: the shape of an
 * error is part of the API, and two shapes would mean every caller learns to
 * handle both.
 */

export interface RequestContext {
  correlationId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

/**
 * The correlation id is HONOURED when the caller supplies one.
 *
 * This is what makes a request traceable across the split. A call that enters at
 * the backend and continues here carries the same id, so two log streams can be
 * joined into one story. Without it the split turns every investigation into
 * matching timestamps by eye (PLAN/14 §9.3).
 */
export function contextFrom(req: IncomingMessage): RequestContext {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    correlationId: header('x-correlation-id') ?? randomUUID(),
    ip: header('x-forwarded-for')?.split(',')[0]?.trim() ?? header('x-real-ip'),
    userAgent: header('user-agent'),
  };
}

/** The largest body this service will read. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads and parses a JSON body, or returns `null`.
 *
 * `null` covers every failure — no body, malformed JSON, too large — because the
 * caller does the same thing with all of them: answer 400 through the schema
 * that was going to validate it anyway. Distinguishing them would produce
 * messages that tell an attacker more than they tell a user.
 *
 * The size cap is not politeness. Without it, one request can hold memory
 * proportional to whatever it decides to send, on the service whose availability
 * every other service depends on.
 */
export async function readJson(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** `Set-Cookie` values, which may legitimately appear more than once. */
  cookies?: string[];
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return headers ? { status, body, headers } : { status, body };
}

export function fail(
  status: number,
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
  correlationId: string,
  details?: Record<string, string[]>,
): Reply {
  const error: ApiError = { error: { code, message, correlationId } };
  if (details) error.error.details = details;
  return { status, body: error };
}

export function send(res: ServerResponse, reply: Reply, correlationId: string): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Echoed so a caller can tie its own log line to this service's, without
    // having to read a body it may be discarding.
    'x-correlation-id': correlationId,
    ...(reply.headers ?? {}),
  };

  if (reply.cookies?.length) headers['set-cookie'] = reply.cookies;

  res.writeHead(reply.status, headers);
  res.end(JSON.stringify(reply.body));
}

// ---------------------------------------------------------------------------
// The refresh cookie
//
// Identical in every property to the backend's version, and it has to be: the
// browser holds ONE cookie, and the two services must agree about its name,
// path, and flags or the session silently stops working on whichever of them is
// wrong. Duplicated rather than shared because the backend builds cookies
// through `NextResponse` and this service writes headers directly — the shape is
// shared, the mechanism cannot be.
// ---------------------------------------------------------------------------

export const REFRESH_COOKIE = 'hrms_rt';

function refreshTtlDays(): number {
  return Number(process.env['REFRESH_TOKEN_TTL_DAYS'] ?? 30);
}

/**
 * Secure by default; only an explicit `false` turns it off.
 *
 * Deliberately NOT derived from `NODE_ENV`. Testing a production build locally
 * over plain HTTP would then always break the session — a browser discards a
 * `Secure` cookie on an insecure connection at every hostname but localhost —
 * and the symptom misleads: login succeeds, the page reloads, and the user is
 * back at the sign-in screen with nothing in the server log.
 *
 * The direction of the default is the point: forgetting this variable produces a
 * safer cookie, not a weaker one.
 */
function cookieSecure(): boolean {
  return process.env['COOKIE_SECURE'] !== 'false';
}

/**
 * `path=/api/auth`, matching the backend exactly.
 *
 * The proxy routes `/api/auth/*` here (PLAN/14 §7), so the path that scopes the
 * cookie is also the path that reaches this service. A request to
 * `/api/employees` never carries the refresh token, and what is never sent
 * cannot leak.
 */
export function setRefreshCookie(token: string): string {
  return [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    cookieSecure() ? 'Secure' : '',
    'SameSite=Strict',
    'Path=/api/auth',
    `Max-Age=${refreshTtlDays() * 86_400}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearRefreshCookie(): string {
  return [
    `${REFRESH_COOKIE}=`,
    'HttpOnly',
    cookieSecure() ? 'Secure' : '',
    'SameSite=Strict',
    'Path=/api/auth',
    'Max-Age=0',
  ]
    .filter(Boolean)
    .join('; ');
}

export function readRefreshCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}
