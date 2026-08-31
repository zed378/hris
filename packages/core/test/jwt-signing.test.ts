import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { generateKeyPair, exportJWK, SignJWT, decodeProtectedHeader } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { signJwt, verifyJwt, JwtVerificationError, ISSUER } from '../src/auth/jwt.ts';
import { publicJwksDocument, signingMode } from '../src/auth/signing-keys.ts';

/**
 * Asymmetric token signing (PLAN/14 §6, stage 1).
 *
 * The reason this has to be right before anything is split: **a symmetric secret
 * cannot distinguish "may verify a token" from "may mint one".** Under HS256 the
 * only way for the backend to check a signature is to hold the secret that
 * creates them, so every service that verifies can also forge — for any user of
 * any tenant. A split shipped on that footing costs four services and buys the
 * security of one.
 *
 * These tests use real key material generated per run, not fixtures. What is
 * under test is the interaction between `jose`, the key ring, and the fallback
 * window, and a stubbed signer would only prove the stub agrees with itself.
 *
 * They do not touch the database: nothing in this layer reads one. Signing and
 * verification take a token and some key material and return a decision, and
 * introducing a tenant would be scenery rather than coverage.
 */

const AUDIENCE = 'hrms-test';
const original = { ...process.env };

interface Pair {
  privateJwk: string;
  publicJwk: Record<string, unknown>;
  kid: string;
}

async function makePair(alg: 'EdDSA' | 'RS256'): Promise<Pair> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomUUID();
  return {
    privateJwk: JSON.stringify({ ...(await exportJWK(privateKey)), alg, kid, use: 'sig' }),
    publicJwk: { ...(await exportJWK(publicKey)), alg, kid, use: 'sig' },
    kid,
  };
}

let ed: Pair;
let ed2: Pair;
let rsa: Pair;

beforeAll(async () => {
  [ed, ed2, rsa] = await Promise.all([makePair('EdDSA'), makePair('EdDSA'), makePair('RS256')]);
});

afterEach(() => {
  process.env = { ...original };
});

/** Puts the process into asymmetric-only mode with the given keys. */
function useKeys(signWith: Pair, verifyWith: Pair[]): void {
  process.env['JWT_PRIVATE_JWK'] = signWith.privateJwk;
  process.env['JWT_PUBLIC_JWKS'] = JSON.stringify({ keys: verifyWith.map((p) => p.publicJwk) });
  delete process.env['JWT_SECRET'];
}

describe('asymmetric signing', () => {
  it('signs and verifies a round trip with Ed25519', async () => {
    useKeys(ed, [ed]);
    const token = await signJwt({ hello: 'world' }, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });
    const payload = await verifyJwt(token, AUDIENCE);

    expect(payload.sub).toBe('u1');
    expect(payload['hello']).toBe('world');
    expect(payload.iss).toBe(ISSUER);
  });

  /**
   * RS256 works identically, which is the point of storing keys as JWKs.
   *
   * PLAN/14 §13.2 leaves EdDSA-or-RS256 open — it depends on whether enterprise
   * SSO is coming — and this test is what makes that a decision about key
   * material rather than a decision about code.
   */
  it('signs and verifies a round trip with RS256', async () => {
    useKeys(rsa, [rsa]);
    const token = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });
    expect((await verifyJwt(token, AUDIENCE)).sub).toBe('u1');
  });

  it('names the signing key in the header, which is what makes rotation possible', async () => {
    useKeys(ed, [ed]);
    const token = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });
    const header = decodeProtectedHeader(token);

    expect(header.kid).toBe(ed.kid);
    expect(header.alg).toBe('EdDSA');
  });

  it('refuses a token signed by a key that is not in the set', async () => {
    useKeys(ed, [ed]);
    const token = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });

    // The signer is withdrawn; only an unrelated key remains.
    useKeys(ed2, [ed2]);
    await expect(verifyJwt(token, AUDIENCE)).rejects.toBeInstanceOf(JwtVerificationError);
  });

  /**
   * Audience separation (P11) survives the move. A control-plane token must
   * never be accepted by the tenant gateway, and vice versa.
   */
  it('refuses a token minted for a different audience', async () => {
    useKeys(ed, [ed]);
    const token = await signJwt({}, { subject: 'u1', audience: 'hrms-admin', ttlSeconds: 60 });
    await expect(verifyJwt(token, 'hrms-tenant')).rejects.toBeInstanceOf(JwtVerificationError);
  });

  it('reports an expired token as expired, not merely invalid', async () => {
    useKeys(ed, [ed]);
    const token = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: -10 });

    // The distinction is what the client acts on: refresh on expired, log out on
    // invalid. Collapsing them makes every ordinary expiry look like a rejected
    // session and signs the user out fifteen minutes into their day.
    try {
      await verifyJwt(token, AUDIENCE);
      expect.unreachable('expired token verified');
    } catch (error) {
      expect(error).toBeInstanceOf(JwtVerificationError);
      expect((error as JwtVerificationError).reason).toBe('expired');
    }
  });
});

describe('rotation', () => {
  /**
   * The overlap window. Without it, rotating a signing key logs every user out
   * at once — which is how key rotation quietly becomes something nobody is
   * willing to do.
   */
  it('keeps verifying tokens from the outgoing key while both are in the set', async () => {
    useKeys(ed, [ed]);
    const oldToken = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });

    // Rotation: new key signs, both keys verify.
    useKeys(ed2, [ed2, ed]);
    const newToken = await signJwt({}, { subject: 'u2', audience: AUDIENCE, ttlSeconds: 60 });

    expect((await verifyJwt(oldToken, AUDIENCE)).sub).toBe('u1');
    expect((await verifyJwt(newToken, AUDIENCE)).sub).toBe('u2');
    expect(decodeProtectedHeader(newToken).kid).toBe(ed2.kid);
  });

  it('stops accepting the old key once it leaves the set', async () => {
    useKeys(ed, [ed]);
    const oldToken = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });

    useKeys(ed2, [ed2]);
    await expect(verifyJwt(oldToken, AUDIENCE)).rejects.toBeInstanceOf(JwtVerificationError);
  });

  /**
   * A `kid` naming a key we do not hold must not short-circuit verification.
   *
   * The header is attacker-controlled, so it is a hint for SELECTING a candidate
   * and never a claim about validity. If an unknown `kid` caused an early
   * rejection, an old token issued before a `kid` was ever set would be refused
   * even though its signature is still good.
   */
  it('still verifies when the kid is unknown but a key in the set matches', async () => {
    useKeys(ed, [ed]);
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    void privateKey;

    // Sign with the real key but claim a different kid.
    const jwk = JSON.parse(ed.privateJwk) as Record<string, unknown>;
    const { importJWK } = await import('jose');
    const key = await importJWK(jwk, 'EdDSA');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'a-kid-nobody-knows' })
      .setSubject('u1')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key);

    expect((await verifyJwt(token, AUDIENCE)).sub).toBe('u1');
  });
});

describe('the HS256 fallback window', () => {
  /**
   * Stage 1 must not log everybody out on deploy.
   *
   * An operator who discovers that every session died the moment they shipped
   * will reach for the rollback rather than the migration, and the migration
   * that gets rolled back once tends not to be attempted again.
   */
  it('still accepts a token signed with the shared secret while it is configured', async () => {
    const secret = 'x'.repeat(48);
    process.env['JWT_SECRET'] = secret;
    delete process.env['JWT_PRIVATE_JWK'];
    delete process.env['JWT_PUBLIC_JWKS'];

    const legacyToken = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });
    expect(decodeProtectedHeader(legacyToken).alg).toBe('HS256');

    // Now the asymmetric key is introduced alongside it — the hybrid state.
    process.env['JWT_PRIVATE_JWK'] = ed.privateJwk;
    process.env['JWT_PUBLIC_JWKS'] = JSON.stringify({ keys: [ed.publicJwk] });

    const newToken = await signJwt({}, { subject: 'u2', audience: AUDIENCE, ttlSeconds: 60 });

    expect(decodeProtectedHeader(newToken).alg).toBe('EdDSA');
    expect((await verifyJwt(legacyToken, AUDIENCE)).sub).toBe('u1');
    expect((await verifyJwt(newToken, AUDIENCE)).sub).toBe('u2');
  });

  /**
   * Withdrawing the secret is what ENDS the migration, and it has to bite.
   *
   * A fallback with no end date leaves the shared secret able to mint tokens
   * forever, which is the exact property the move to asymmetric keys exists to
   * remove. Same reasoning as the PII key ring: the breakage is the evidence
   * that the migration finished.
   */
  it('refuses HS256 tokens once the secret is withdrawn', async () => {
    process.env['JWT_SECRET'] = 'x'.repeat(48);
    delete process.env['JWT_PRIVATE_JWK'];
    delete process.env['JWT_PUBLIC_JWKS'];
    const legacyToken = await signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 });

    useKeys(ed, [ed]);
    await expect(verifyJwt(legacyToken, AUDIENCE)).rejects.toBeInstanceOf(JwtVerificationError);
  });

  it('reports which mode the process is in', async () => {
    process.env['JWT_SECRET'] = 'x'.repeat(48);
    delete process.env['JWT_PRIVATE_JWK'];
    expect(await signingMode()).toBe('hs256');

    process.env['JWT_PRIVATE_JWK'] = ed.privateJwk;
    expect(await signingMode()).toBe('hybrid');

    delete process.env['JWT_SECRET'];
    expect(await signingMode()).toBe('asymmetric');
  });

  it('refuses to sign at all when no key of any kind is configured', async () => {
    delete process.env['JWT_SECRET'];
    delete process.env['JWT_PRIVATE_JWK'];
    delete process.env['JWT_PUBLIC_JWKS'];

    await expect(
      signJwt({}, { subject: 'u1', audience: AUDIENCE, ttlSeconds: 60 }),
    ).rejects.toThrow(/kunci penandatangan/i);
  });
});

describe('algorithm confusion', () => {
  /**
   * The classic JWT attack, and the reason the algorithm comes from the KEY.
   *
   * A public key is public. If a verifier trusted the token's own `alg` header,
   * an attacker could sign a token HS256 using that public key as the HMAC
   * secret, and a naive verifier would check it against the same bytes and
   * accept. Taking `alg` from the key we chose makes the header's claim
   * irrelevant.
   */
  it('refuses an HS256 token forged with the public key as its secret', async () => {
    useKeys(rsa, [rsa]);

    const publicMaterial = new TextEncoder().encode(JSON.stringify(rsa.publicJwk));
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: rsa.kid })
      .setSubject('attacker')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(publicMaterial);

    await expect(verifyJwt(forged, AUDIENCE)).rejects.toBeInstanceOf(JwtVerificationError);
  });

  it('refuses an unsigned token', async () => {
    useKeys(ed, [ed]);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString('base64url');

    await expect(verifyJwt(`${header}.${body}.`, AUDIENCE)).rejects.toBeInstanceOf(
      JwtVerificationError,
    );
  });

  it('refuses malformed input rather than throwing something unhandled', async () => {
    useKeys(ed, [ed]);
    for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '...']) {
      await expect(verifyJwt(bad, AUDIENCE), bad).rejects.toBeInstanceOf(JwtVerificationError);
    }
  });
});

describe('the published JWKS', () => {
  it('serves exactly the configured public keys', () => {
    useKeys(ed, [ed, ed2]);
    const doc = publicJwksDocument();

    expect(doc.keys.map((k) => k.kid)).toEqual([ed.kid, ed2.kid]);
  });

  /**
   * The mistake this guards against is pasting the PRIVATE JWK into the public
   * variable. Every other symptom of that would look like a healthy system —
   * tokens verify, screens load, nothing raises — while the signing key is
   * served to anyone who fetches the endpoint.
   */
  it('strips private key material even when it is present', () => {
    process.env['JWT_PUBLIC_JWKS'] = JSON.stringify({ keys: [JSON.parse(ed.privateJwk)] });
    const doc = publicJwksDocument();

    expect(doc.keys).toHaveLength(1);
    expect(doc.keys[0]).not.toHaveProperty('d');
    expect(doc.keys[0]).toHaveProperty('x');
    expect(doc.keys[0]!.kid).toBe(ed.kid);
  });

  it('returns an empty set rather than failing when no key is configured', () => {
    delete process.env['JWT_PUBLIC_JWKS'];
    expect(publicJwksDocument()).toEqual({ keys: [] });
  });

  it('refuses a key set whose entries carry no kid', () => {
    const { kid: _kid, ...noKid } = ed.publicJwk as { kid?: string };
    process.env['JWT_PUBLIC_JWKS'] = JSON.stringify({ keys: [noKid] });
    expect(() => publicJwksDocument()).toThrow(/kid/i);
  });
});
