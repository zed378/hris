#!/usr/bin/env node
/**
 * Generates a JWT signing key pair as JWKs (PLAN/14 stage 1).
 *
 *   node ops/scripts/generate-jwt-keys.mjs            # EdDSA (Ed25519)
 *   node ops/scripts/generate-jwt-keys.mjs RS256      # RSA, 2048-bit
 *   node ops/scripts/generate-jwt-keys.mjs EdDSA admin
 *
 * Prints the two environment variables to set. It never writes to `.env` — an
 * operator pasting a key deliberately is a step worth keeping, and a script that
 * edits environment files gets run twice by accident.
 *
 * ## Why JWKs rather than PEMs
 *
 * A JWK carries its own `kty`, `crv`/`n`, `alg`, and `kid`. The algorithm is
 * therefore a property of the KEY rather than a separate setting that can
 * disagree with it — and the public set is literally what
 * `/.well-known/jwks.json` serves, so the endpoint has nothing to assemble.
 *
 * ## EdDSA or RS256
 *
 * PLAN/14 §13.2 leaves this open on purpose. Ed25519 is smaller and faster and
 * is the better default. RS256 is what enterprise SSO counterparties tend to
 * expect, so if SAML/OIDC federation is genuinely coming, generate RS256 and
 * avoid a second migration.
 *
 * Switching later is a change of key material, not of code.
 *
 * ## Rotating
 *
 * `JWT_PUBLIC_JWKS` is a SET. To rotate: generate a new pair, APPEND its public
 * JWK to the existing set, then switch `JWT_PRIVATE_JWK` to the new private key.
 * Tokens signed by the old key keep verifying until they expire — at most one
 * access-token TTL — and only then is the old public key removed.
 *
 * Skipping the overlap logs every user out at once, which is how key rotation
 * quietly becomes something nobody is willing to do.
 */
import { generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';

const alg = process.argv[2] ?? 'EdDSA';
const realm = process.argv[3] ?? 'tenant';

if (!['EdDSA', 'RS256', 'ES256'].includes(alg)) {
  console.error(`Algoritma tidak dikenal: ${alg}. Pilih EdDSA, RS256, atau ES256.`);
  process.exit(1);
}

if (!['tenant', 'admin'].includes(realm)) {
  console.error(`Realm tidak dikenal: ${realm}. Pilih tenant atau admin.`);
  process.exit(1);
}

// `extractable` is required: the whole point is to export the key material.
const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });

// The key id is random rather than derived from the key. A thumbprint would be
// reproducible, which sounds tidy and means two generations of the same key
// material would collide in the set — precisely during a rotation, which is the
// one time the set has to hold two distinct entries.
const kid = randomUUID();

const privateJwk = { ...(await exportJWK(privateKey)), alg, kid, use: 'sig' };
const publicJwk = { ...(await exportJWK(publicKey)), alg, kid, use: 'sig' };

const prefix = realm === 'admin' ? 'ADMIN_JWT' : 'JWT';

console.log(`# ${alg}, realm ${realm}, kid ${kid}`);
console.log('#');
console.log('# The PRIVATE key belongs only to whatever issues tokens. After the auth');
console.log('# service is split out (PLAN/14 stage 6) it must NOT be in the backend or');
console.log('# worker environment — a service holding it can mint a token for any user');
console.log('# of any tenant, which is the property the split exists to remove.');
console.log('');
console.log(`${prefix}_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`);
console.log('');
console.log('# The PUBLIC set. Every verifier needs it, and it is what');
console.log('# /.well-known/jwks.json serves. To rotate, APPEND rather than replace.');
console.log('');
console.log(`${prefix}_PUBLIC_JWKS='${JSON.stringify({ keys: [publicJwk] })}'`);
