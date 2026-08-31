import { log } from '@hrms/observability';
import type { AccessDenial } from '@hrms/core/iam';

/**
 * Talking to the auth service (PLAN/14 stage 6).
 *
 * Used only when `AUTH_SERVICE_URL` is set. Unset — the default — the gateway
 * authorizes in-process exactly as before, and this file is never reached.
 *
 * That switch is what makes stage 6 reversible in practice rather than only on
 * paper. The monolith stays a complete, working deployment; the split is a
 * configuration rather than a fork, and a rollback is an environment variable
 * instead of a revert. `PLAN/14` §10 calls stage 6 the commitment point, and
 * this is what keeps the commitment from being irreversible on the first day.
 */

export interface RemoteDecision {
  allowed: boolean;
  reason: AccessDenial | null;
  tenantId: string;
  tenantCode: string;
  userId: string;
  email: string;
  modules: string[];
  permissions: string[];
  accessVersion: number;
}

export type RemoteOutcome =
  | { kind: 'decision'; decision: RemoteDecision }
  /** The token is bad. The auth service said so; we do not second-guess it. */
  | { kind: 'rejected'; expired: boolean }
  /** Auth could not be reached or did not make sense. See `unavailable`. */
  | { kind: 'unavailable' };

export function authServiceUrl(): string | null {
  const url = process.env['AUTH_SERVICE_URL'];
  return url?.trim() ? url.replace(/\/+$/, '') : null;
}

/**
 * The timeout is short on purpose.
 *
 * This call sits on the hot path of every authenticated request. A generous
 * timeout does not make a struggling auth service work; it makes the backend
 * struggle alongside it, holding connections while it waits. Two seconds is far
 * beyond a healthy round trip on the same network and far below anything a user
 * would sit through.
 */
const TIMEOUT_MS = 2_000;

/**
 * Asks the auth service what this token may do.
 *
 * **The token is sent, not its contents.** The backend does not verify tokens at
 * all in this topology — it has no key with which to do so, which is the entire
 * point of stage 1 — and sending a `userId` instead would let anything that can
 * reach this endpoint authorize itself as any user of any tenant.
 */
export async function authorizeRemotely(
  token: string,
  module: string,
  permission: string | null,
  correlationId: string,
): Promise<RemoteOutcome> {
  const base = authServiceUrl();
  if (!base) return { kind: 'unavailable' };

  const secret = process.env['AUTH_INTERNAL_SECRET'];
  if (!secret) {
    // Refused rather than attempted. Calling without the secret produces a 404
    // that looks exactly like a routing mistake, and the real cause — a missing
    // variable — would be the last thing anybody checked.
    log.error({ scope: 'auth-client', event: 'missing-internal-secret', correlationId });
    return { kind: 'unavailable' };
  }

  try {
    const response = await fetch(`${base}/internal/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': secret,
        // Carried across the boundary so one request produces one story in the
        // logs, rather than two that have to be matched by timestamp.
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ token, module, permission }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 401) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      return { kind: 'rejected', expired: body?.error?.code === 'TOKEN_EXPIRED' };
    }

    if (!response.ok) {
      log.error({
        scope: 'auth-client',
        event: 'unexpected-status',
        status: response.status,
        correlationId,
      });
      return { kind: 'unavailable' };
    }

    return { kind: 'decision', decision: (await response.json()) as RemoteDecision };
  } catch (error) {
    log.error({ scope: 'auth-client', event: 'unreachable', correlationId, error });
    return { kind: 'unavailable' };
  }
}

/**
 * What the gateway does when auth cannot be reached.
 *
 * **503, and nothing else.** Not a fallback to local resolution, and not an
 * allow.
 *
 * The temptation is real: the backend in this topology still shares a database
 * with auth, so it *could* resolve permissions itself when the call fails. That
 * would be a second implementation of the authorization decision, exercised only
 * during incidents — which is to say, never tested — and diverging quietly from
 * the one that normally runs. `PLAN/14` risk S3 is exactly this: a degraded mode
 * discovered during an incident rather than designed.
 *
 * So the degraded mode is refusal, and it is honest about being one. The client
 * retries, the orchestrator sees 503 and routes elsewhere, and nobody is served
 * a decision made by code that has not run in production for a month.
 */
export const AUTH_UNAVAILABLE_STATUS = 503;
