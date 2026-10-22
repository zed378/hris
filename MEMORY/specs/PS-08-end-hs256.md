# PS-08 — End the HS256 Window

Status: **Implemented** — 2026-10-22
Task: `TASKS/PHASE-S-SERVICE-SPLIT.md` PS-08
Plan refs: `docs/PLAN/14` §6 and §10.1, `docs/SECURITY/02` §3(a)(f), risk S1, ADR-038

## 1. Business Objective
No environment can mint a valid tenant or admin token with a shared secret. Done when a token signed with `JWT_SECRET` (or the derived admin secret) is refused even while the variable is still set.

## 2. Actors
Operators deploying the stack; an attacker holding a leaked `JWT_SECRET`.

## 3. Functional Requirements
- **FR1** `signJwt` signs only with the realm's private JWK; with none configured it throws, naming the variable to set.
- **FR2** `verifyJwt` accepts only keys in the realm's public JWKS. No HS256 path exists.
- **FR3** `signingMode()` reports `asymmetric` or `unconfigured`.
- **FR4** `ops/docker-compose.yml` requires both key pairs on the web container (in-process auth, ADR-032) and no longer reads `JWT_SECRET`.

## 4–5. Non-functional requirements and dependencies
None new. Deployments must hold `JWT_PRIVATE_JWK`/`JWT_PUBLIC_JWKS` and the `ADMIN_` pair (`node ops/scripts/generate-jwt-keys.mjs`).

## 6–9. Database, API, frontend, backend
No database or API change. Backend: `packages/core/src/auth/jwt.ts`, `signing-keys.ts`; `legacySecret` removed.

## 10–13. Authorization, validation, errors, edge cases
A live HS256 token, issued before the deploy, is refused: the user refreshes and receives an EdDSA token. A refresh token is not a JWT and is unaffected, so nobody is logged out. A deployment without private keys fails every login. That failure is loud on purpose, and `/api/ready` reports `signing: unconfigured`.

## 14. Abuse Cases
§3(f): a token signed with a leaked `JWT_SECRET`, or with the derived admin secret, is refused even while the variable is set. §3(a): HS256 signed with the public key was already refused.

## 15–16. Logging, controls
Closes risk S1.

## 17–19. Testing, acceptance, DoD
`packages/core/test/jwt-signing.test.ts` «HS256 is gone» — four cases, all failing before the change.

## 20–22. Sequence, rollback, risks
Rollback is a revert. Risk: an environment configured only with `JWT_SECRET` stops issuing tokens on deploy. That is intended, and the compose file refuses to start without the keys.
