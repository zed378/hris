# Service Split — Stages 1–7 Summary

| | |
|---|---|
| **Phase** | Track S — `docs/PLAN/14` |
| **Started** | 2026-08-31 (commit `61f2291`, "plan the auth split") |
| **Completed** | Stages 1–7 and the stage 8 precondition on 2026-08-31; stage 8 open |
| **Tasks done** | 9 / 14 |
| **Release tag** | None |
| **Reconstructed** | **Yes** — from `docs/PLAN/14` §10.1–10.8 (written with the work) and commits `d7197ad` to `00e3c84` |

`docs/PLAN/14` §10 is itself a contemporaneous build record, stage by stage. This summary indexes it; read §10 for the reasoning.

---

## What Shipped

| Stage | Commit | Result | On by default |
|---|---|---|---|
| 1 | `d7197ad` | EdDSA tokens with `kid`, public JWKS; HS256 still verifies while `JWT_SECRET` is set | Yes when keys are configured |
| 2 | `eea666f` | Access version compared on every request — the mechanism existed and was never checked | Yes |
| 3 | `e66abde` | Redis rate limits shared across replicas; fail-open; readiness reports the mode | Yes when `REDIS_URL` is set |
| 4 | `b815b39` | One authorization function, `decideAccess`; lint bars the web app from bypassing it | Yes |
| 5 | `37444af` | `hrms_auth` role with its own grant matrix, tested | Yes |
| — | `774cbdc` | Permission cache with two invalidation axes: access version and tenant generation | Yes |
| 6 | `46afaa9` | `apps/auth` container; the backend calls `/internal/authorize`; `503`, never a local fallback | **No** — `AUTH_SERVICE_URL` |
| 7 | `02c25e6` | Broker seam; NATS JetStream | **No** — `BROKER_URL` |
| 8 (precondition) | `99924e0` | Frontend proven API-only; test enforces it | Yes |

## Verification

- `apps/auth/test/service.test.ts`: 22 tests over real HTTP against a real database — routing, the internal-secret guard, rate limiting, cookie serialisation, the error envelope.
- `rls-coverage.test.ts`: the `hrms_auth` and `hrms_platform` grant matrices.
- `broker.test.ts`: delivery, envelope integrity, topic isolation, no redelivery, ordering — against a real NATS.
- `ops/Dockerfile.auth` built once by hand (commit `efa0430`); no CI build.

## Bugs Found During the Split

From `docs/PLAN/14` §10:

- The access version was **written but never compared** before stage 2 — a revoked permission stayed usable until the token expired.
- Rate limits were **per process**: every limit silently multiplied by the replica count (§9.2). Stage 3's first version also missed the first request after a Redis restart (cold start), fixed in the same stage.
- The auth service answered a malformed token with `400`, which the backend read as "auth is unwell" and reported as `503` — its own outage for a bad credential (§10.6).
- `frontend-boundary.test.ts` matched nothing when first written (ADR-020).

## Deviations

Built ahead of `docs/PLAN/12` §9's triggers — ADR-017, `DV-10`; `12` §9.1 amended.

## Still Open

`PS-08` (HS256 window), `PS-09` (`hrms_app` reads `auth.users`), `PS-10` (shared secret, not mTLS), `PS-11` (stage 8), `PS-12` (latency of remote authorization, never measured). **`OQ-03` decides whether any of it continues.**

## What to Watch

- Readiness reporting `signing: hybrid` in production — the HS256 secret can still mint tokens.
- Readiness reporting `rateLimit: in-process` with more than one replica.
- Turning on `AUTH_SERVICE_URL` without a load test: every authenticated request gains a network round trip.
