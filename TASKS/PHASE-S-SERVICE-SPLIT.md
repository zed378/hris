# Phase S — Service Split

**Goal** (`docs/PLAN/14`): extract authentication into its own service, with the platform around it — asymmetric tokens, enforced access versions, shared rate limits, a hard authorization boundary, split database roles, an opt-in broker — staged so that every stage leaves the system better whether or not the next one happens.

**State**: stages 1–7 built on 2026-08-31 (`docs/PLAN/14` §10.1–10.7); the auth service and the broker are **opt-in and off by default**. Stage 8's precondition is met and enforced (§10.8). The split was built ahead of `docs/PLAN/12` §9's triggers (`DV-10`, ADR-017).

**Decided 2026-09-14** (`OQ-03`, ADR-032): authorization stays in backend logic, in-process; SSO may come later; there is no public API. Following `docs/PLAN/14` §12 S8, the split **stops here**: stages 1–5 stay in use, the auth service and broker stay built, tested, and off. Work that only matters once auth runs separately (`PS-10`, `PS-11`, `PS-12`) waits for a decision to adopt SSO (`DF-11`). `PS-08` and `PS-09` remain worthwhile in the monolith.

---

## Delivered

| ID | Stage | Delivered | Evidence | Status |
|---|---|---|---|---|
| PS-01 | 1 | EdDSA signing with `kid`, JWKS endpoint, HS256 hybrid verification window | `jwt-signing.test.ts`; commit `d7197ad` | DONE (retro) |
| PS-02 | 2 | Access version enforced on every request → `TOKEN_STALE` | `authorize.test.ts`; commit `eea666f` | DONE (retro) |
| PS-03 | 3 | Redis-backed rate limits shared across replicas, fail-open, cold start fixed | `rate-limit.test.ts`; commit `e66abde` | DONE (retro) |
| PS-04 | 4 | Authorization behind `decideAccess`; lint forbids `resolveEffectiveAccess` in `apps/web` | `eslint.config.js`; commit `b815b39` | DONE (retro) |
| PS-05 | 5 | `hrms_auth` role and grant matrix, asserted by test | `rls-coverage.test.ts`; commit `37444af` | DONE (retro) |
| PS-06 | 6 | `apps/auth` service: own image, own role; opt-in via `AUTH_SERVICE_URL`; `503` never a local fallback; proxy config | `apps/auth/test/service.test.ts` (22 tests); commit `46afaa9` | DONE (retro) |
| PS-07 | 7 | Broker seam; NATS JetStream opt-in via `BROKER_URL`; pg-boss default | `broker.test.ts`; commit `02c25e6` | DONE (retro) |
| PS-13 | 8 (precondition) | Frontend proven API-only and enforced | `frontend-boundary.test.ts`; commit `99924e0` | DONE (retro) |
| PS-14 | — | Permission cache keyed by access version and tenant generation | `access-cache.test.ts` | DONE (retro) |

---

## Open

### PS-08 — End the HS256 window

| | |
|---|---|
| **Status** | DONE — 2026-10-22 (ADR-038) |
| **Priority** | P1 |
| **Depends on** | — |
| **Blocked by** | — (`OQ-14` answered: end it now) |
| **Plan refs** | `docs/PLAN/14` §6 and §10.1, `docs/SECURITY/02` §3(f), risk S1 |
| **Spec required** | Yes — authentication |
| **Surface** | auth, backend, ops |
| **Size** | S |

**Goal** — no environment can mint a valid tenant or admin token with a shared secret.

**Steps**
1. Update `ops/.env.compose.example` and `ops/docker-compose.yml` to configure `JWT_PRIVATE_JWK`/`JWT_PUBLIC_JWKS` and the admin equivalents, not `JWT_SECRET`.
2. Deploy EdDSA keys everywhere; wait one access-token lifetime (15 minutes).
3. Unset `JWT_SECRET` and `ADMIN_JWT_SECRET`; decide in the spec whether the HS256 verification path is removed from code or kept behind the unset variable.

**Definition of Done**
- `/api/ready` reports signing not `hybrid` on every environment.
- A test: with `JWT_SECRET` unset, an HS256 token signed with the old secret is refused.
- `docs/PLAN/20` §4, `docs/PLAN/17` §9, `docs/SECURITY/02` §3, risk S1 updated.

**Abuse cases to test** — `SECURITY/02` §3(a)(f).

### PS-09 — Revoke `hrms_app`'s read of `auth.users`

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/PLAN/14` §10.5 and §10.6 "Still open", `docs/PLAN/17` §9 |
| **Spec required** | Yes — tenant isolation, data model access |
| **Surface** | backend, db |
| **Size** | L |

**Goal** — the six modules reading `auth.users` read what they need through `iam` or a view without credential columns, and the grant is revoked. Still worthwhile with auth in-process (ADR-032): the web runtime should not be able to read password hashes it never needs.

**Steps** — list the six reads; move each; add the revocation migration; extend the grant matrix test to assert `hrms_app` cannot select `auth.users`.

**Definition of Done** — the grant-matrix assertion in `rls-coverage.test.ts`, seen to fail before the revoke; the full suite passes.

### PS-10 — Service identity beyond a shared secret

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P3 |
| **Blocked by** | `DF-11` — auth running as a separate service, which is not planned (ADR-032) |
| **Plan refs** | `docs/PLAN/14` §10.6, `docs/SECURITY/02` §10 |
| **Spec required** | Yes |
| **Surface** | auth, ops |
| **Size** | L |

### PS-11 — Stage 8: separate frontend and backend builds

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P3 |
| **Blocked by** | `DF-11` (SSO adopted) or a separately deployed client; then the CORS and cookie decision of `docs/PLAN/14` §7 and §10.8 |
| **Plan refs** | `docs/PLAN/14` §10.8, §11 |
| **Spec required** | Yes — cookies and origins |
| **Surface** | web, ops |
| **Size** | L |

### PS-12 — Measure the cost of remote authorization

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P3 |
| **Blocked by** | `DF-11` — only relevant if `AUTH_SERVICE_URL` is ever enabled; then `P6-21` |
| **Plan refs** | `docs/PLAN/14` §5 and §10.6, `docs/PLAN/18` §3, risk S3 |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | M |

**Goal** — p50/p95 added per authenticated request in the split topology, with the permission cache warm and cold, and the degraded behaviour when `auth` is slow.

**Definition of Done** — numbers recorded in `docs/PLAN/18` §2; a decision by ADR on whether the split topology is acceptable at the stated capacity.
