import { NextResponse } from 'next/server';
import { publicJwksDocument } from '@hrms/core/auth';
import { definePublicRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public key set for verifying access tokens (PLAN/14 §6, stage 1).
 *
 * Public by definition — a JWKS is meant to be fetched by anything that has to
 * verify a token, and a public key discloses nothing. It is what lets the
 * backend, and later the separately-deployed services, check a signature without
 * holding anything that could produce one.
 *
 * That distinction is the entire point of stage 1. Under HS256 the only way for
 * the backend to verify was to hold the shared secret, and a secret that can
 * verify can also mint: the backend, the worker, and anything reading their
 * environment could forge a token for any user of any tenant. A split shipped on
 * that footing has the operational cost of four services and the security
 * posture of one.
 *
 * ## An empty set is a real answer
 *
 * Before any asymmetric key is configured this returns `{"keys": []}` rather
 * than a 404 or an error. A verifier reading it learns the truth — this issuer
 * has no asymmetric keys yet — and falls back to whatever it was doing. A 404
 * would be indistinguishable from a misrouted request, and an error would make a
 * deployment that is working perfectly look broken.
 *
 * ## Private members are stripped before serving
 *
 * `publicJwksDocument` removes `d`, `p`, `q`, and the rest even though a
 * correctly-configured `JWT_PUBLIC_JWKS` never contains them. Pasting a private
 * JWK into the public variable is a plausible mistake, it would publish the
 * signing key to anyone who fetches this URL, and every other symptom would look
 * like a healthy system: tokens verify, screens load, nothing raises.
 *
 * ## Cached, but not for long
 *
 * Five minutes. Long enough that verifiers are not refetching on every request,
 * short enough that adding a key to the set during a rotation is picked up
 * without a deploy. The rotation overlap is measured in token TTLs — fifteen
 * minutes — so a cache longer than that would make the new key unusable for as
 * long as it was stale.
 */
export const GET = definePublicRoute('GET /api/.well-known/jwks.json', async () => {
  return NextResponse.json(publicJwksDocument(), {
    headers: { 'cache-control': 'public, max-age=300' },
  });
});
