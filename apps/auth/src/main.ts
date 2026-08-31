import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { log } from '@hrms/observability';
import { disconnectAll } from '@hrms/db';
import { disconnectRedis } from '@hrms/cache';
import { createAuthServer } from './server.ts';

/**
 * The auth service (PLAN/14 stage 6).
 *
 * Identity, sessions, tokens, and the authorization decision, in a deployable of
 * their own. What justifies the separation is not tidiness — document 12 argues
 * well against splitting on taste — but four things specific to auth: it is the
 * only module everything depends on and which depends on nothing; its change
 * rate is lowest and its blast radius widest; argon2 gives it a scaling profile
 * unlike any other module; and it is the natural home for SSO, SAML, and an
 * OAuth server, none of which has a sensible place in a monolith gateway.
 *
 * ## It is not the default
 *
 * The backend still authorizes in-process unless `AUTH_SERVICE_URL` is set. That
 * is what makes stage 6 reversible in practice rather than only on paper: the
 * monolith remains a complete, working deployment, and the split is a
 * configuration rather than a fork. A rollback is an environment variable, not a
 * revert.
 *
 * ## Why the route table is explicit
 *
 * The same reasoning as `ROUTE_MANIFEST` in the backend (P7): a handler that
 * exists but was never registered is unreachable, and a route registered without
 * a decision about rate limiting is caught here rather than in production. Nine
 * routes are small enough to read in one screen, which is the point.
 */

const PORT = Number(process.env['AUTH_PORT'] ?? 3001);

const server = createAuthServer();

server.listen(PORT, () => {
  log.info({ scope: 'auth-service', event: 'listening', port: PORT });
});

/**
 * Stops accepting connections, finishes what is in flight, then closes the
 * pools.
 *
 * The order matters. Closing the database first would fail the requests already
 * running — the ones a deploy is most likely to interrupt — and a rolling
 * restart would show up to users as a scattering of 500s rather than as nothing
 * at all.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ scope: 'auth-service', event: 'shutdown', signal });
  server.close();
  await disconnectAll();
  await disconnectRedis();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
