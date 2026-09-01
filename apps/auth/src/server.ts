import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ErrorCode } from '@hrms/contracts';
import { log, runWithContext } from '@hrms/observability';
import { consumeRateLimit } from '@hrms/cache';
import { contextFrom, fail, send } from './http.ts';
import { ROUTES } from './routes.ts';

/**
 * The auth service's HTTP layer, separated from its startup.
 *
 * `main.ts` binds a port, installs signal handlers, and never returns; a test
 * needs a server on an ephemeral port that it can close again. Keeping the two
 * apart means the tests exercise the REAL routing, rate limiting, and internal
 * guard rather than a rearrangement of them written for testability — which
 * would be testing the rearrangement.
 */

/**
 * A route id built from the method and path only.
 *
 * The query string is deliberately discarded: no endpoint here reads one, and
 * including it would turn `?x=1` into a distinct unregistered route — a 404 for
 * a request that is perfectly valid.
 */
export function routeId(req: IncomingMessage): string {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  return `${req.method ?? 'GET'} ${path}`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = contextFrom(req);
  const id = routeId(req);
  const rule = ROUTES[id];

  if (!rule) {
    // 404 rather than 405 for a known path with the wrong method. Distinguishing
    // them tells a scanner which paths exist, and nothing legitimate needs the
    // difference.
    send(res, fail(404, ErrorCode.NOT_FOUND, 'Not found', ctx.correlationId), ctx.correlationId);
    return;
  }

  /**
   * Internal routes are refused unless the caller proves it is one of ours.
   *
   * The proxy is supposed to keep `/internal/*` off the public origin (§7), and
   * this is the layer that holds when it does not — a misconfigured proxy is a
   * likelier failure than a stolen secret, and one line of configuration should
   * not be the only thing between the internet and the authorization endpoint.
   *
   * The refusal is a 404, not a 403. A 403 would confirm the endpoint exists,
   * which is precisely what someone probing for it wants to learn.
   *
   * A shared secret rather than mTLS, for now. Its weaknesses are real and
   * stated in PLAN/14 §10.6: it does not rotate on its own, and it is as strong
   * as the environment holding it. Enough for two containers on one network, and
   * it must be replaced before they are on different ones.
   */
  if (rule.internal) {
    const expected = process.env['AUTH_INTERNAL_SECRET'];
    const presented = req.headers['x-internal-secret'];

    if (!expected || presented !== expected) {
      send(
        res,
        fail(404, ErrorCode.NOT_FOUND, 'Not found', ctx.correlationId),
        ctx.correlationId,
      );
      return;
    }
  }

  if (rule.rateLimit) {
    const allowed = await consumeRateLimit(
      `auth:${id}:${ctx.ip ?? 'unknown'}`,
      rule.rateLimit.max,
      rule.rateLimit.windowSeconds,
    );

    if (!allowed) {
      send(
        res,
        fail(
          429,
          ErrorCode.RATE_LIMITED,
           'Too many requests. Try again in a moment.',
          ctx.correlationId,
        ),
        ctx.correlationId,
      );
      return;
    }
  }

  try {
    send(res, await rule.handler(req, ctx), ctx.correlationId);
  } catch (error) {
    log.error({ scope: 'auth-service', routeId: id, correlationId: ctx.correlationId, error });
    send(
      res,
      fail(500, ErrorCode.INTERNAL,        'A system error occurred', ctx.correlationId),
      ctx.correlationId,
    );
  }
}

export function createAuthServer(): Server {
  return createServer((req, res) => {
    const ctx = contextFrom(req);

    // One wrapper at the boundary, so the correlation id reaches every log line
    // without being threaded through functions that have nothing to do with
    // logging — and without being forgotten in the next one somebody writes.
    void runWithContext({ correlationId: ctx.correlationId, routeId: routeId(req) }, () =>
      handle(req, res),
    );
  });
}
