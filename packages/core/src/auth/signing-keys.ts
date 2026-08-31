import { importJWK, type JWK, type KeyObject } from 'jose';

/**
 * Token signing keys (PLAN/14 §6, stage 1).
 *
 * Access tokens have been signed HS256 with a shared `JWT_SECRET`. In one
 * process that is fine — the signer and the verifier are the same code.
 *
 * Across four containers it is not, and the reason is exact: **a symmetric
 * secret cannot distinguish "may verify a token" from "may mint one".** Giving
 * the backend the secret so it can verify makes the backend able to forge a
 * token for any user of any tenant. So can the worker. So can anything that
 * reads the environment of either. The whole point of a separate auth service —
 * that credentials and issuance live inside one blast radius — is cancelled by
 * the key distribution, and the system ends up with the operational cost of four
 * services and the security posture of one.
 *
 * So the split cannot ship on HS256, and this is the piece that has to land
 * first. It lands now, while everything is still one process, because it is
 * worth doing on its own and because it is far easier to get right before there
 * is a network in the middle.
 *
 * ## Keys are JWKs, not PEMs
 *
 * A JWK carries its own `kty`, `crv`, `alg`, and `kid`. That matters for a
 * decision `PLAN/14` §13.2 deliberately leaves open: EdDSA is smaller and
 * faster, RS256 is what enterprise SSO counterparties tend to expect, and which
 * one is right depends on whether SSO is actually coming. With self-describing
 * key material that choice is a change of key, not a change of code — no
 * `JWT_ALG` variable to disagree with the key it describes.
 *
 * The public set is also literally what `/.well-known/jwks.json` serves, so the
 * endpoint has nothing to construct and nothing to get wrong.
 *
 * ## Two keys are always valid
 *
 * `JWT_PUBLIC_JWKS` is a SET. Rotation adds the new key to the set and switches
 * `JWT_PRIVATE_JWK` to it; tokens signed by the outgoing key keep verifying
 * until they expire, and only then is it removed. Without that overlap, rotating
 * a signing key logs every user out at once — which is how key rotation quietly
 * becomes something nobody is willing to do.
 *
 * ## HS256 still verifies, deliberately
 *
 * While `JWT_SECRET` is configured, tokens signed with it are still accepted.
 * The alternative is a deploy that invalidates every live session, and an
 * operator who discovers that at the wrong moment will reach for the rollback
 * rather than the migration. `signingAlgorithm()` reports which mode is active
 * so the state is observable rather than guessed.
 */

export interface SigningKey {
  key: KeyObject | Uint8Array;
  alg: string;
  kid: string;
}

/**
 * Named separately from `SigningKey` although the shape is identical, because
 * the two are not interchangeable: one of these may mint tokens and the others
 * may only check them. The distinction is the entire reason for this file.
 */
type VerificationKey = SigningKey;

/**
 * Imported keys, cached by the exact environment string that produced them.
 *
 * `importJWK` is asynchronous and not free, and this runs on the verification
 * path of every authenticated request. Keying the cache on the raw value rather
 * than a boolean means a process whose environment is reloaded picks up the new
 * key without a restart, and a test that swaps keys between cases is not served
 * a stale one.
 */
const importCache = new Map<string, Promise<SigningKey[]>>();

function parseJwks(raw: string, label: string): JWK[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} bukan JSON yang sah.`);
  }

  const keys =
    Array.isArray((parsed as { keys?: unknown }).keys) ? (parsed as { keys: JWK[] }).keys
    : Array.isArray(parsed) ? (parsed as JWK[])
    : [parsed as JWK];

  for (const key of keys) {
    if (!key.kid) throw new Error(`${label}: setiap kunci wajib punya "kid".`);
    if (!key.alg) throw new Error(`${label}: kunci "${key.kid}" tidak menyebut "alg".`);
  }

  return keys;
}

async function importAll(raw: string, label: string): Promise<SigningKey[]> {
  const cached = importCache.get(raw);
  if (cached) return cached;

  const promise = (async () => {
    const imported: SigningKey[] = [];
    for (const jwk of parseJwks(raw, label)) {
      const key = await importJWK(jwk, jwk.alg);
      imported.push({ key: key as KeyObject | Uint8Array, alg: jwk.alg!, kid: jwk.kid! });
    }
    return imported;
  })();

  importCache.set(raw, promise);
  return promise;
}

/**
 * Tenant tokens and control-plane tokens are signed by DIFFERENT keys.
 *
 * This preserves a property the HS256 implementation already had and that would
 * have been quietly lost in the move: the admin secret was derived as
 * `admin:${secret}`, so a tenant token and a superuser token could never verify
 * against each other even if the audience check were removed or broken.
 *
 * Audience separation (P11) is a real check and does the work. This is the layer
 * underneath it — the one that still holds when the layer above has a bug. A
 * single shared key pair would have made `aud` the only thing standing between a
 * tenant session and the control plane.
 *
 * A realm whose asymmetric keys are not configured stays on its legacy secret.
 * The two planes migrate independently, which is what allows the tenant plane to
 * move first without a coordinated cutover of both.
 */
export type KeyRealm = 'tenant' | 'admin';

interface RealmConfig {
  privateVar: string;
  publicVar: string;
}

const REALMS: Record<KeyRealm, RealmConfig> = {
  tenant: { privateVar: 'JWT_PRIVATE_JWK', publicVar: 'JWT_PUBLIC_JWKS' },
  admin: { privateVar: 'ADMIN_JWT_PRIVATE_JWK', publicVar: 'ADMIN_JWT_PUBLIC_JWKS' },
};

/** The key that SIGNS, or `null` when this realm is still on HS256. */
export async function privateSigningKey(realm: KeyRealm = 'tenant'): Promise<SigningKey | null> {
  const { privateVar } = REALMS[realm];
  const raw = process.env[privateVar];
  if (!raw?.trim()) return null;

  const keys = await importAll(raw, privateVar);
  const key = keys[0];
  if (!key) throw new Error(`${privateVar} tidak memuat satu pun kunci.`);
  return key;
}

/**
 * Every key that may VERIFY.
 *
 * Empty is a valid answer — it means this deployment has not moved off HS256
 * yet, and the caller falls back to the shared secret.
 */
export async function publicVerificationKeys(
  realm: KeyRealm = 'tenant',
): Promise<VerificationKey[]> {
  const { publicVar } = REALMS[realm];
  const raw = process.env[publicVar];
  if (!raw?.trim()) return [];
  return importAll(raw, publicVar);
}

/**
 * The public key set, exactly as `/.well-known/jwks.json` must serve it.
 *
 * Private components are stripped rather than trusted to be absent. Publishing
 * `d` from an accidentally-pasted private JWK hands out the signing key to
 * anyone who fetches the endpoint, and it would look like a working deployment
 * in every other respect — the tokens verify, the dashboard loads, and nothing
 * ever raises. This filter is cheap and the failure it prevents is total.
 */
export function publicJwksDocument(realm: KeyRealm = 'tenant'): { keys: JWK[] } {
  const { publicVar } = REALMS[realm];
  const raw = process.env[publicVar];
  if (!raw?.trim()) return { keys: [] };

  const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'] as const;

  return {
    keys: parseJwks(raw, publicVar).map((jwk) => {
      const safe: Record<string, unknown> = { ...jwk };
      for (const member of PRIVATE_MEMBERS) delete safe[member];
      return safe as JWK;
    }),
  };
}

/**
 * The HS256 secret for a realm, while one is still configured.
 *
 * The admin realm derives `admin:${secret}` exactly as before. Changing that
 * derivation would invalidate every live superuser session, and — worse — a
 * derivation that accidentally matched the tenant one would make the two planes
 * interchangeable, which is the failure this separation exists to prevent.
 */
export function legacySecret(realm: KeyRealm = 'tenant'): Uint8Array | null {
  if (realm === 'admin') {
    const value = process.env['ADMIN_JWT_SECRET'] ?? process.env['JWT_SECRET'];
    if (!value || value.length < 32) return null;
    return new TextEncoder().encode(`admin:${value}`);
  }

  const value = process.env['JWT_SECRET'];
  if (!value || value.length < 32) return null;
  return new TextEncoder().encode(value);
}

/**
 * Which mode this process is in — for the readiness endpoint and the logs.
 *
 * `hybrid` is the expected state DURING a migration and an alarming one after
 * it: the shared secret is still accepted, so anything holding it can still mint
 * tokens, which is the exact property the move to asymmetric keys exists to
 * remove. Naming the state is how it stops being invisible.
 */
export async function signingMode(
  realm: KeyRealm = 'tenant',
): Promise<'asymmetric' | 'hybrid' | 'hs256'> {
  const hasPrivate = (await privateSigningKey(realm)) !== null;
  const hasLegacy = legacySecret(realm) !== null;

  if (hasPrivate && hasLegacy) return 'hybrid';
  if (hasPrivate) return 'asymmetric';
  return 'hs256';
}
