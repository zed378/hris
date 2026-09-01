import { SignJWT, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import {
  legacySecret,
  privateSigningKey,
  publicVerificationKeys,
  type KeyRealm,
} from './signing-keys.ts';

/**
 * Signing and verifying, in one place for both audiences.
 *
 * Tenant tokens and superuser tokens were signed by two separate copies of the
 * same four lines, in `auth/tokens.ts` and `platform/superuser-auth.ts`. That
 * was survivable while both said `HS256` and nothing else. It stops being
 * survivable the moment there is a key to select, an algorithm to agree on, and
 * a fallback window to end — three things that must be identical in both places
 * and would drift the first time only one of them was updated.
 *
 * The drift would also be silent in the worst direction: the copy left behind
 * keeps minting HS256 tokens that the other still accepts, so the migration
 * looks finished while one door is still open.
 *
 * The audience separation (P11) is unchanged and still the caller's to state.
 */

export const ISSUER = 'hrms';

export interface SignOptions {
  subject: string;
  audience: string;
  ttlSeconds: number;
  /** Which key set signs this token. Defaults to the tenant plane. */
  realm?: KeyRealm;
}

export async function signJwt(
  claims: JWTPayload,
  { subject, audience, ttlSeconds, realm = 'tenant' }: SignOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signer = new SignJWT(claims)
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds);

  const key = await privateSigningKey(realm);

  if (key) {
    // `kid` in the header is what lets a verifier pick the right key without
    // trying all of them — and, more importantly, what makes rotation possible
    // at all: two keys are valid at once and each token says which one signed it.
    return signer.setProtectedHeader({ alg: key.alg, typ: 'JWT', kid: key.kid }).sign(key.key);
  }

  const secret = legacySecret(realm);
  if (!secret) {
    throw new Error(
      'No signing key configured. Set JWT_PRIVATE_JWK (recommended) ' +
        'or a JWT_SECRET of at least 32 characters.',
    );
  }

  return signer.setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(secret);
}

export class JwtVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: 'expired' | 'invalid',
  ) {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

/**
 * Verifies a token against whichever key signed it.
 *
 * The algorithm is taken from the KEY, never from the token. A verifier that
 * trusts the token's own `alg` header is the classic JWT confusion attack: a
 * token can claim `alg: none`, or claim HS256 and be verified with an RSA public
 * key as if that key were an HMAC secret — and the public key is, by definition,
 * something the attacker has.
 *
 * The header's `kid` is used only to SELECT a candidate, which is a hint and not
 * a claim: choosing the wrong key produces a failed signature, so a lie there
 * costs the attacker nothing and gains them nothing.
 */
export async function verifyJwt(
  token: string,
  audience: string,
  realm: KeyRealm = 'tenant',
): Promise<JWTPayload> {
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new JwtVerificationError('Invalid token', 'invalid');
  }

  const keys = await publicVerificationKeys(realm);
  // The named key first, then the rest. A token whose `kid` is unknown — an old
  // one, or a forged one — still gets tried against every key we hold, so
  // removing a key from the set is what ends its validity, not the label.
  const ordered = kid ? [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)] : keys;

  let expired = false;

  for (const candidate of ordered) {
    try {
      const { payload } = await jwtVerify(token, candidate.key, {
        issuer: ISSUER,
        audience,
        algorithms: [candidate.alg],
      });
      return payload;
    } catch (error) {
      // An expired token is expired regardless of which key we try next, and the
      // distinction matters to the caller: the client refreshes on `expired` and
      // logs out on `invalid`. Collapsing the two would make every expiry look
      // like a rejected session.
      if ((error as { code?: string }).code === 'ERR_JWT_EXPIRED') expired = true;
    }
  }

  const secret = legacySecret(realm);
  if (secret) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: ISSUER,
        audience,
        algorithms: ['HS256'],
      });
      return payload;
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_JWT_EXPIRED') expired = true;
    }
  }

  if (expired) throw new JwtVerificationError('Token expired', 'expired');
  throw new JwtVerificationError('Invalid token', 'invalid');
}
