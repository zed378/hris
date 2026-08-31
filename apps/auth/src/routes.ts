import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  ErrorCode,
  loginRequestSchema,
  passwordSchema,
  tenantCodeSchema,
  emailSchema,
} from '@hrms/contracts';
import {
  login,
  refresh,
  logout,
  requestPasswordReset,
  completePasswordReset,
  acceptInvitation,
  AuthError,
  ActionTokenError,
  publicJwksDocument,
  signingMode,
} from '@hrms/core/auth';
import { decideAccess } from '@hrms/core/iam';
import { withTenant, authClient } from '@hrms/db';
import { rateLimitBackend } from '@hrms/cache';
import {
  clearRefreshCookie,
  fail,
  json,
  readJson,
  readRefreshCookie,
  setRefreshCookie,
  type Reply,
  type RequestContext,
} from './http.ts';

/**
 * Everything the auth service answers (PLAN/14 stage 6).
 *
 * Six of these are the endpoints lifted out of `apps/web` unchanged in
 * behaviour: login, refresh, logout, the two password-reset halves, and
 * invitation acceptance. They move because they are the only routes that touch
 * credentials, and confining credentials to one deployable is the entire point
 * of the split.
 *
 * The seventh, `POST /internal/authorize`, is new and is the reason the split is
 * affordable at all — see below.
 */

export interface RouteHandler {
  (req: IncomingMessage, ctx: RequestContext): Promise<Reply>;
}

export interface RouteRule {
  handler: RouteHandler;
  /**
   * Requests per window, per address. Every public route has one.
   *
   * The same reasoning as the backend's manifest: login without a rate limit
   * turns per-account lockout into a weapon — an outsider can lock out every
   * employee of a company one failed attempt at a time.
   */
  rateLimit?: { windowSeconds: number; max: number };
  /**
   * `true` for endpoints only other services may call.
   *
   * These are refused at the proxy, not merely undocumented. See §7: one public
   * origin, and `/internal/*` is not part of it.
   */
  internal?: boolean;
}

/** Empty body, for the endpoints that deliberately say nothing. */
const NO_CONTENT = { status: 204, body: null } as const;

export const ROUTES: Record<string, RouteRule> = {
  'POST /api/auth/login': {
    rateLimit: { windowSeconds: 300, max: 20 },
    handler: async (req, ctx) => {
      const parsed = loginRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        return fail(
          400,
          ErrorCode.VALIDATION_FAILED,
          'Data login tidak lengkap atau tidak sah',
          ctx.correlationId,
          parsed.error.flatten().fieldErrors as Record<string, string[]>,
        );
      }

      try {
        const result = await login(parsed.data, ctx);

        // The refresh token does NOT travel in the body. It exists only as an
        // httpOnly cookie, so page JavaScript never holds it and therefore
        // cannot put it anywhere durable (PLAN/11 §5.3).
        const { refreshToken, ...body } = result;
        return { ...json(200, body), cookies: [setRefreshCookie(refreshToken)] };
      } catch (error) {
        if (error instanceof AuthError) {
          const status =
            error.code === ErrorCode.ACCOUNT_LOCKED ? 423
            : error.code === ErrorCode.TENANT_SUSPENDED ? 403
            : 401;

          const reply = fail(status, error.code, error.message, ctx.correlationId);
          if (error.retryAfterSeconds !== undefined) {
            reply.headers = { 'retry-after': String(error.retryAfterSeconds) };
          }
          return reply;
        }
        throw error;
      }
    },
  },

  'POST /api/auth/refresh': {
    rateLimit: { windowSeconds: 60, max: 30 },
    handler: async (req, ctx) => {
      const token = readRefreshCookie(req);
      if (!token) {
        return fail(401, ErrorCode.TOKEN_INVALID, 'Tidak ada sesi', ctx.correlationId);
      }

      try {
        const { refreshToken, ...body } = await refresh(token, ctx);
        return { ...json(200, body), cookies: [setRefreshCookie(refreshToken)] };
      } catch (error) {
        if (error instanceof AuthError) {
          // The cookie is cleared on every failure. Leaving a dead cookie in
          // place makes the client keep trying to refresh a session that no
          // longer exists, and the user watches it fail repeatedly instead of
          // being shown the sign-in screen.
          return {
            ...fail(401, error.code, error.message, ctx.correlationId),
            cookies: [clearRefreshCookie()],
          };
        }
        throw error;
      }
    },
  },

  'POST /api/auth/logout': {
    rateLimit: { windowSeconds: 60, max: 30 },
    handler: async (req) => {
      const token = readRefreshCookie(req);

      // Always 204, including for a session nobody recognises. Logout is not a
      // place to tell the caller whether a session ever existed.
      if (token) await logout(token);
      return { ...NO_CONTENT, cookies: [clearRefreshCookie()] };
    },
  },

  'POST /api/auth/password/forgot': {
    rateLimit: { windowSeconds: 900, max: 5 },
    handler: async (req, ctx) => {
      const schema = z.object({ tenantCode: tenantCodeSchema, email: emailSchema });
      const parsed = schema.safeParse(await readJson(req));

      // Always 204, whatever happened — invalid input included. A reply that
      // distinguished "registered" from "not registered" would turn this into a
      // tool for enumerating a company's employee email addresses, and that list
      // is exactly what is most useful to an attacker.
      if (parsed.success) await requestPasswordReset(parsed.data, ctx);
      return NO_CONTENT;
    },
  },

  'POST /api/auth/password/reset': {
    rateLimit: { windowSeconds: 900, max: 10 },
    handler: async (req, ctx) => {
      const schema = z.object({ token: z.string().min(20).max(256), newPassword: passwordSchema });
      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) {
        return fail(
          400,
          ErrorCode.VALIDATION_FAILED,
          'Data tidak lengkap atau kata sandi kurang dari 12 karakter',
          ctx.correlationId,
          parsed.error.flatten().fieldErrors as Record<string, string[]>,
        );
      }

      try {
        await completePasswordReset(parsed.data, ctx);
        return NO_CONTENT;
      } catch (error) {
        if (error instanceof ActionTokenError) {
          return fail(400, ErrorCode.TOKEN_INVALID, error.message, ctx.correlationId);
        }
        throw error;
      }
    },
  },

  'POST /api/auth/invitation/accept': {
    rateLimit: { windowSeconds: 900, max: 10 },
    handler: async (req, ctx) => {
      const schema = z.object({ token: z.string().min(20).max(256), password: passwordSchema });
      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) {
        return fail(
          400,
          ErrorCode.VALIDATION_FAILED,
          'Kata sandi minimal 12 karakter',
          ctx.correlationId,
        );
      }

      try {
        return json(200, await acceptInvitation(parsed.data, ctx));
      } catch (error) {
        if (error instanceof ActionTokenError) {
          return fail(400, ErrorCode.TOKEN_INVALID, error.message, ctx.correlationId);
        }
        throw error;
      }
    },
  },

  'GET /api/.well-known/jwks.json': {
    handler: async () =>
      json(200, publicJwksDocument(), { 'cache-control': 'public, max-age=300' }),
  },

  /**
   * The authorization RPC — the reason the split is affordable.
   *
   * The backend asks this instead of resolving permissions itself, because after
   * stage 6 it has no grant on `iam` or `tenant` to resolve them with. The answer
   * is the same `AccessDecision` the in-process seam returns (stage 4), so the
   * backend's mapping from decision to status code is unchanged.
   *
   * **The token is verified HERE, not trusted from the caller.** Accepting a
   * `userId` in the body would make this endpoint a way to ask "what may this
   * person do" about anybody, and — far worse — a way for a compromised backend
   * to authorize itself as any user of any tenant. The caller sends the token it
   * received; this service decides what it means.
   *
   * `internal: true` keeps it off the public origin (§7). That is defence in
   * depth rather than the control: even reachable, it discloses nothing that the
   * bearer of the token could not already obtain by using it.
   */
  'POST /internal/authorize': {
    internal: true,
    handler: async (req, ctx) => {
      const schema = z.object({
        /**
         * Deliberately only bounded, not shaped.
         *
         * A minimum length here would answer 400 for a token that is merely
         * short — and the caller reads a non-401 as "auth is unwell" and returns
         * 503. Measured: a client presenting `not.a.real.token` got a 503,
         * meaning the backend reported its own outage for what was plainly a bad
         * credential.
         *
         * Deciding whether a token is valid is this endpoint's whole job, and
         * `verifyAccessToken` is what does it. The cap remains, because an
         * unbounded string is a memory question rather than a validity one.
         */
        token: z.string().min(1).max(8192),
        module: z.string().min(1).max(64),
        permission: z.string().min(1).max(128).nullable(),
      });

      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) {
        return fail(400, ErrorCode.VALIDATION_FAILED, 'Permintaan tidak sah', ctx.correlationId);
      }

      const { verifyAccessToken, TokenVerificationError } = await import('@hrms/core/auth');

      let claims;
      try {
        claims = await verifyAccessToken(parsed.data.token);
      } catch (error) {
        const expired =
          error instanceof TokenVerificationError && error.reason === 'expired';
        return fail(
          401,
          expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
          expired ? 'Token akses kedaluwarsa' : 'Token akses tidak sah',
          ctx.correlationId,
        );
      }

      const decision = await withTenant(
        claims.tid,
        (tx) =>
          decideAccess(tx, {
            tenantId: claims.tid,
            userId: claims.sub,
            tokenAccessVersion: claims.av,
            module: parsed.data.module,
            permission: parsed.data.permission,
          }),
        { client: authClient() },
      );

      /**
       * The identity travels with the decision.
       *
       * The backend needs `tenantId`, `userId`, and `email` to do its own work,
       * and it can no longer read them from the token itself — it has no way to
       * verify one. Returning them here means exactly one component verifies
       * tokens, which is the property the split is for.
       */
      return json(200, {
        allowed: decision.allowed,
        reason: decision.allowed ? null : decision.reason,
        tenantId: claims.tid,
        tenantCode: claims.tenantCode,
        userId: claims.sub,
        email: claims.email,
        modules: decision.access.modules,
        permissions: decision.access.permissions,
        accessVersion: decision.access.accessVersion,
      });
    },
  },

  'GET /health': {
    handler: async () => json(200, { status: 'ok' }),
  },

  /**
   * Readiness, distinct from liveness.
   *
   * Readiness decides whether traffic is SENT here; liveness decides whether the
   * process is KILLED. A service whose database is unreachable should stop
   * receiving requests and must not be restarted — restarting does not fix a
   * database and only lengthens the recovery.
   *
   * The reply carries no version, no database name, and no raw error: this
   * endpoint is unauthenticated because an orchestrator calls it before any
   * session exists, and details here are a gift to whoever is scanning.
   */
  'GET /ready': {
    handler: async () => {
      try {
        await authClient().plan.findFirst({ select: { code: true } });

        return json(200, {
          status: 'ready',
          signing: await signingMode(),
          rateLimit: rateLimitBackend(),
        });
      } catch {
        // 503, not 500. An orchestrator reads 503 as "do not send traffic here
        // for now"; a 500 reads as an application error still worth requests.
        return { ...json(503, { status: 'not_ready' }), headers: { 'retry-after': '5' } };
      }
    },
  },
};
