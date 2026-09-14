# P6-18 — API Documentation: Coverage, Interactive Page, Secret-Header Access

Status: **Reviewed** — the user accepted the recommendations on 2026-09-14 (`OQ-11`, ADR-031). Decisions below are final unless a new ADR supersedes them.
Task: `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` P6-18
Plan refs: `docs/PLAN/15` §10, `docs/PLAN/17` §8, `docs/SECURITY/02` §12, `apps/web/src/lib/openapi.ts`, `apps/web/src/app/api/openapi.json/route.ts`, ADR-031

---

## 1. Business Objective

The user wants API documentation they can browse (Swagger UI), available only to a logged-in administrator **and** only with an additional request header carrying a secret the user sets and stores protected in the database. Today a generated OpenAPI document exists behind `core.settings.manage`, documents 14 of 100 tenant routes, and has no interactive page; a comment in `openapi.ts` claims a coverage test that does not exist.

Done when: every route is documented, a test keeps it so, and the interactive documentation opens only for an administrator presenting the secret.

## 2. Actors

The platform operator (the user) — sets and rotates the secret; an administrator browsing documentation; anyone else attempting to read it.

## 3. Functional Requirements

**P6-18.1 — coverage**
- FR1 A test fails when a `ROUTE_MANIFEST` entry has no `DOCS` entry, except routes in an explicit allowlist.
- FR2 The allowlist starts at the 86 undocumented routes and a test fails if it **grows**.

**P6-18.2 — content**
- FR3 Every tenant route has a summary, and request/response schemas where it takes or returns a body. The allowlist reaches zero.

**P6-18.3 — access** (decided 2026-09-14, ADR-031)
- FR4 An interactive documentation page under `/admin` rendering `/admin/api/docs/openapi.json`.
- FR5 The page and the JSON require an authenticated **platform superuser** session.
- FR6 **And** a request header, e.g. `X-Docs-Key`, whose value matches a stored secret.
- FR7 The secret is set by the operator through an `ops` script, shown once when generated, and never logged.
- FR8 Rotation: two secrets valid at once, the older with an expiry.
- FR9 Storage: an **Argon2id hash** in the database. The original request said "encrypt"; hashing was recommended as the stronger form for a verify-only secret and accepted.
- FR10 The tenant route `GET /api/openapi.json` is removed; the document is served only on the control plane.

## 4. Non-Functional Requirements

The page's assets load under the Content Security Policy from `P6-12`. The JSON is generated once per process, not per request.

## 5. Dependencies

`P6-12` (CSP) for the page; `P3-12` (trusted client address) for per-address throttling of wrong secrets; Argon2id (`packages/core/src/auth/password.ts`) for the key hash.

## 6. Design — decided 2026-09-14 (ADR-031)

The options considered are kept below; the chosen one is marked **Chosen**.

### Who is "admin"?

| Option | Meaning | Consequence |
|---|---|---|
| a | A **tenant** user with `core.settings.manage` (today's guard) | Each tenant's owner can read the API documentation. One platform-wide secret would then be shared with no tenant — only the operator knows it — so in practice only the operator can open it through a tenant account |
| b | A **platform superuser** (`hrms-admin` token) | Matches "only I can know the secret". The document is still the **tenant** API; serving it from the control plane is fine because it contains no tenant data |

**Chosen: (b)**, for both the page and the JSON. `GET /api/openapi.json` on the tenant plane is removed.

### Encrypt or hash?

The secret only ever needs to be **verified**, never read back.

| | Encrypt (PII key ring) | Hash (Argon2id) |
|---|---|---|
| A database dump plus the key reveals the secret | Yes | No |
| A database dump alone reveals it | No | No (offline guessing only; a long random secret defeats it) |
| The application can display it later | Yes | No |

**Chosen: hash with Argon2id**, generated as ≥ 32 random bytes by the setting script and shown once.

### Where stored

A `platform.api_docs_keys` table: `id`, `hash`, `created_at`, `expires_at`, `created_by`. In the `platform` schema, readable by `hrms_platform` only — no `tenant_id`, so no RLS; grants restrict it.

### How set

**Chosen:** `ops/scripts/set-docs-key.mjs` run by the operator against the database as `hrms_owner`: generates the secret, prints it once, stores the hash, optionally expires the previous one in 24 hours. No screen — a screen is another surface to protect.

## 7. API Contract

| Route | Plane | Guard | Response |
|---|---|---|---|
| Page `/admin/docs` | Control | Superuser session (the key is entered on the page) | Client page that fetches the JSON below |
| `GET /admin/api/docs/openapi.json` | Control | Same | OpenAPI 3.1 JSON |
| `GET /api/openapi.json` | Tenant | — | **Removed** (with its manifest entry) |

Refusals: no session or a tenant token → `401`; wrong or missing `X-Docs-Key` → **`404`** (as `/internal/*` does — a `403` confirms the page exists); too many wrong keys → `429` with `retry-after`.

A browser cannot add a custom header to a top-level navigation, so the page is a small client page that asks for the key, holds it **in memory only**, and fetches the JSON with the header. **Chosen:** in-memory, re-entered per session. (Rejected: exchanging the key for a short-lived cookie — one more credential to protect.)

## 8. Frontend Changes

A documentation page under `/admin` using Swagger UI, Scalar, or Redoc from the pinned npm package (no CDN — `P6-12` CSP). A key prompt. No link from tenant pages.

## 9. Backend Changes

- `apps/web/test/openapi-coverage.test.ts` (18.1).
- `DOCS` entries (18.2).
- `packages/core/src/platform/docs-keys.ts`: verify a presented key against unexpired hashes with Argon2id; constant-time by construction.
- Two admin routes in `ADMIN_ROUTE_MANIFEST`.
- The false comment in `openapi.ts` corrected in 18.1.

## 10. Authorization Rules

Superuser session **and** a valid key. Neither alone suffices. Tenant administrators have no access to the API documentation.

## 11. Validation

`X-Docs-Key`: 32–256 characters; anything else is a wrong key (`404`), without hashing oversized input.

## 12. Error Handling

§7 refusals. Argon2id verification failures never distinguish "no keys configured" from "wrong key".

## 13. Edge Cases

No key configured → every request `404`. Two active keys during rotation. An expired key. The superuser session expiring mid-browse → the page asks to sign in again, key re-entered.

## 14. Abuse Cases

| Scenario | `SECURITY/02` | Expected |
|---|---|---|
| Tenant user requests the admin docs route | §12, §9 | `401`/`404` |
| Superuser without the key | §12 | `404` |
| Brute force of the key | §2 (analogous) | `429` after N attempts per session and per trusted address |
| Key appears in logs | §8(b) | Redaction covers `x-docs-key`; test asserts |
| Key embedded in the OpenAPI document or page source | §18 | Never; test asserts |
| Timing difference between a wrong key and no configured keys | §12 | Same code path |

## 15. Logging and Audit

`platform.platform_audit_logs`: key created, key expired, documentation opened (superuser id, not the key). Logger redaction extended to the header.

## 16. Security Controls

Argon2id hashing, `404` on refusal, rate limiting after `P3-12`, CSP from `P6-12`, redaction, control-plane separation (P11).

## 17. Testing Strategy

- 18.1: the coverage test, seen to fail by adding an undocumented route.
- 18.3: integration tests against real PostgreSQL through the real admin route handlers for every row of §14; the setting script run against a test database.

## 18. Acceptance Criteria

§3 FRs; §14 rows pass; `docs/PLAN/15` §10 and `docs/PLAN/17` §8 updated.

## 19. Definition of Done

`TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` P6-18 plus the global DoD.

## 20. Implementation Sequence

18.1 → 18.2 (module by module, allowlist shrinking) → `P6-12` (CSP) → migration for `platform.api_docs_keys` → verify function and tests → setting script → admin routes → page → documentation.

## 21. Rollback Strategy

18.1/18.2: test and content only. 18.3: the new table is additive; the previous image ignores it; the admin routes disappear with the image.

## 22. Technical Risks

Exposing the full API surface to anyone who obtains a superuser session and the key — mitigated by both being required; a documentation library adding third-party scripts — pinned package, CSP.
