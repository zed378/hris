/**
 * Resolves the client address for a request, respecting the trusted-proxy model.
 *
 * ## Threat model
 *
 * The client address is used for three things: office-network verification
 * (removing the `WEB_UNVERIFIED_DEVICE` penalty), per-address rate limiting,
 * and audit rows. All three are defeated if a client can supply its own address.
 *
 * The reference proxy (`ops/proxy/proxy-common.inc`) sets `X-Real-IP
 * $remote_addr` — the actual peer address — and appends to `X-Forwarded-For`.
 * A client that sends `X-Forwarded-For: <office>` through that proxy gets
 * `X-Forwarded-For: <office>, <real>`. The application must read the address
 * the proxy observed, not the one the client wrote.
 *
 * ## Trust model (P3-12 spec §6, Option A)
 *
 * - `TRUST_PROXY=true` (explicit): read **only** `X-Real-IP`. The proxy
 *   overwrites any client-supplied value, so this is the one the client cannot
 *   have chosen.
 * - `TRUST_PROXY=false` or unset (default): ignore all forwarding headers.
 *   The address is `undefined` — "unknown". Office verification never matches;
 *   all per-address limits share one bucket; audit rows record null. That is
 *   the honest result for a deployment with no trustworthy proxy in front of it.
 *
 * ## Internal forwarded-address header
 *
 * When `apps/web` forwards a request to `apps/auth` (docs/PLAN/14 stage 6), it
 * passes the already-resolved address in `X-Forwarded-Client-IP`. The auth
 * service accepts this header **only** from a caller carrying a valid
 * `x-internal-secret` — otherwise it applies the same `clientAddress` logic to
 * its own inbound headers.
 *
 * ## Misconfiguration
 *
 * `TRUST_PROXY=true` with no `X-Real-IP` present logs a `warn` once per process
 * (not per request), then returns `undefined`. No request fails because of the
 * address.
 *
 * Plan refs: `MEMORY/specs/P3-12-trusted-client-address.md` §6, §9, §12;
 * `docs/SECURITY/02` §4; risk F1.
 */

import { log } from './logger.ts';

/**
 * Whether a trusted reverse proxy is configured in front of this process.
 *
 * Read once at module load — logging is on the hot path and an env read on
 * every request is a cost nothing pays for.
 */
const TRUST_PROXY = process.env['TRUST_PROXY'] === 'true';

/** Whether a misconfiguration warning has already been emitted this process. */
let misconfigurationWarned = false;

/**
 * The resolved client address, or `undefined` when it cannot be determined.
 *
 * `undefined` is the safe result in every context:
 * - Office verification: no match → `FALLBACK_ONLY` refuses a punch without
 *   evidence, which is correct when the address is unknown.
 * - Rate limiting: `unknown` bucket → all unknown addresses share one limit,
 *   which is the honest result when the address is untrusted.
 * - Audit rows: `null` → the row is honest about what it recorded.
 */
export function clientAddress(headers: Headers | Record<string, string | string[] | undefined>): string | undefined {
    if (!TRUST_PROXY) {
        return undefined;
    }

    const get = (name: string): string | undefined => {
        const value = headers instanceof Headers
            ? headers.get(name)
            : (Array.isArray(headers[name]) ? headers[name]![0] : headers[name]);
        return typeof value === 'string' ? value : undefined;
    };

    const realIp = get('x-real-ip');

    if (!realIp) {
        // Warn once, not every request. The absence of the header when trust is
        // enabled is a deployment misconfiguration, not a client error.
        if (!misconfigurationWarned) {
            misconfigurationWarned = true;
            log.warn({
                scope: 'client-address',
                event: 'trusted-proxy-no-real-ip',
                message:
                    'TRUST_PROXY is set but X-Real-IP header is absent. ' +
                    'Ensure a reverse proxy that sets X-Real-IP is in front of this service.',
            });
        }
        return undefined;
    }

    // Multiple values in X-Real-IP are malformed — a proxy sends exactly one.
    if (realIp.includes(',')) {
        return undefined;
    }

    return realIp.trim() || undefined;
}

/**
 * Whether the deployment trusts a reverse proxy for client-address resolution.
 *
 * Reported in `/api/ready` so an operator can verify the configuration without
 * reading the environment.
 */
export function clientAddressMode(): 'trusted-proxy' | 'untrusted' {
    return TRUST_PROXY ? 'trusted-proxy' : 'untrusted';
}

/**
 * The header `apps/web` uses to hand the auth service the address it already
 * resolved.
 *
 * The proxy strips it from client requests (`proxy_set_header X-Internal-Secret
 * ""` and friends in `ops/proxy/proxy-common.inc`), and the auth service only
 * reads it from a caller holding the internal secret — so a client cannot
 * inject it.
 */
export const FORWARDED_CLIENT_IP_HEADER = 'x-forwarded-client-ip';

/**
 * The address a service behind the backend should use for the original caller.
 *
 * `apps/auth` sits behind no proxy of its own in the split topology, so it
 * cannot resolve the address from its own headers. The backend resolved it
 * already and passes it in `x-forwarded-client-ip`.
 *
 * **The internal secret is the precondition.** Without it the header is
 * ignored entirely and the address falls back to the local resolution — a
 * client that learns the header name learns nothing, because presenting it
 * without the secret gets it no closer to the truth.
 */
export function forwardedClientAddress(
    headers: Headers | Record<string, string | string[] | undefined>,
    internalSecretValid: boolean,
): string | undefined {
    if (!internalSecretValid) return undefined;

    const get = (name: string): string | undefined => {
        const value = headers instanceof Headers
            ? headers.get(name)
            : (Array.isArray(headers[name]) ? headers[name]![0] : headers[name]);
        return typeof value === 'string' ? value : undefined;
    };

    const forwarded = get(FORWARDED_CLIENT_IP_HEADER);
    if (!forwarded || forwarded.includes(',')) return undefined;

    return forwarded.trim() || undefined;
}