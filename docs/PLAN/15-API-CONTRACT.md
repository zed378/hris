# 15 — API Contract

How every HTTP endpoint in this system behaves: where it lives, how it is authorized, what it returns when it refuses, and how it is documented. Written against the running system on 2026-09-13; where the code and this document disagree, the disagreement is a finding for `TASKS/BACKLOG.md`, not a license to pick one.

The authorization model itself — roles, permissions, menus, precedence — is `05-Dynamic-Role-Menu-Access.md`. Tenant isolation is `06-Multitenancy-Auth.md`. This document is the contract a caller experiences.

---

## 1. The Three Planes

| Plane | Prefix | Served by | Token audience | Registered in |
|---|---|---|---|---|
| Tenant | `/api/**` | `apps/web` (Next.js route handlers) | `hrms-tenant` | `ROUTE_MANIFEST`, `apps/web/src/lib/route-manifest.ts` — 100 routes |
| Control | `/admin/api/**` | `apps/web` | `hrms-admin` | `ADMIN_ROUTE_MANIFEST`, same file — 6 routes |
| Auth service | `/api/auth/*`, `/api/.well-known/jwks.json`, `/internal/authorize`, `/health`, `/ready` | `apps/auth` (`node:http`), **only when split** | issues `hrms-tenant` | `ROUTES`, `apps/auth/src/routes.ts` |

The planes never accept each other's tokens (P11). The auth service is opt-in: without `AUTH_SERVICE_URL` the tenant plane serves `/api/auth/*` itself and authorizes in-process (`14-Service-Split-and-Platform-Evolution.md` §10.6).

## 2. Registration Is Mandatory (P7)

A route handler is written through one of two wrappers, and nothing else:

```ts
export const GET  = defineRoute('GET /api/leave/balances', async (req, ctx) => { ... });
export const POST = definePublicRoute('POST /api/auth/login', async (req, ctx) => { ... });
```

- The route id must exist in `ROUTE_MANIFEST` with its `module` and `permission`. An unregistered id throws **when the module loads**, not on the first request.
- `public: true` in the manifest must agree with `definePublicRoute`; a disagreement also throws at load.
- `apps/web/test/route-manifest.test.ts` compares the manifest against the `route.ts` files on disk in both directions.

Adding an endpoint therefore forces two decisions before any logic: which module owns it, and which permission guards it.

## 3. The Request Chain

Every authenticated tenant-plane request passes these steps **in this order**, in `apps/web/src/lib/define-route.ts`. The order is load-bearing:

| # | Step | Refusal |
|---|---|---|
| 1 | Manifest lookup | route not registered → never reached (load-time throw) |
| 2 | Per-route rate limit (per address) | `429 RATE_LIMITED` + `retry-after` |
| 3 | Bearer token, audience `hrms-tenant` | `401 TOKEN_INVALID` / `TOKEN_EXPIRED` |
| 4 | `X-Tenant-ID`, if sent, must equal the token's `tid` | `403 TENANT_MISMATCH` |
| 5 | Per-tenant quota — **outside** the transaction, so it cannot consume the connection it protects | `429 RATE_LIMITED` + `retry-after` |
| 6 | `withTenant(tid)` — one connection, RLS context set | — |
| 7 | `decideAccess`: access version, then module, then permission | `401 TOKEN_STALE` → `402 MODULE_NOT_SUBSCRIBED` → `403 PERMISSION_DENIED` |
| 8 | The handler | its own errors |
| — | Any uncaught throw | `500 INTERNAL`, logged with the correlation id |

Step 7's order is the contract `packages/core/test/authorize.test.ts` pins with states where two things are wrong at once:

- **Staleness first** — a token whose access version disagrees with the record describes permissions that are no longer true. The client refreshes and retries; the user sees nothing.
- **Module before permission (P8)** — "your plan does not include this module" is something a customer can act on. "Access denied" is not.

In the split topology, steps 3 and 7 become a call to `POST /internal/authorize`; the status mapping is identical, and an unreachable auth service is `503` — **never** a local fallback (`14` §10.6).

## 4. Headers

| Header | Direction | Meaning |
|---|---|---|
| `Authorization: Bearer <jwt>` | request | Access token. 15-minute TTL (`ACCESS_TOKEN_TTL_SECONDS`) |
| `X-Tenant-ID` | request, optional | **Confirms** the tenant; never its source. The token's `tid` is the source |
| `x-correlation-id` | both | Honoured when supplied, generated otherwise, echoed by the auth service, carried into `outbox.correlation_id` and the worker's logs |
| `x-forwarded-for` | request | Read for per-address rate limits and office-network verification. **See §9 — currently trusted from the client** |
| `retry-after` | response | On every `429`, `423`, and `503` |
| `Set-Cookie: hrms_rt=…` | response | The refresh token: `HttpOnly`, `Secure` unless `COOKIE_SECURE=false`, `SameSite=Strict`, `Path=/api/auth` |

The refresh token **never** appears in a response body. It lives only in the cookie, so page JavaScript never holds it (`11-PWA-Frontend.md` §5.3).

## 5. The Access Token

```json
{
  "sub": "<user uuid>",
  "tid": "<tenant uuid>",
  "tenantCode": "demo",
  "email": "staff@demo.test",
  "av": 7,
  "aud": "hrms-tenant",
  "iss": "hrms",
  "iat": 1788000000,
  "exp": 1788000900
}
```

- Signed **EdDSA** with a `kid` when `JWT_PRIVATE_JWK` is set; public keys at `GET /api/.well-known/jwks.json`. No HS256: a token signed with a shared secret is refused (ADR-038).
- `av` is the access version. It is compared on every request; a mismatch is `401 TOKEN_STALE`.
- Control-plane tokens use audience `hrms-admin`, an 8-hour TTL, a separate key realm (`ADMIN_JWT_*`), and are refused by the tenant gateway.

## 6. The Error Envelope

Every error from every plane has one shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "…",
    "correlationId": "5f0c…",
    "details": { "email": ["…"] }
  }
}
```

`code` is the contract; `message` is **English prose for developers and logs** and may change (ADR-030). **The frontend never shows `message` to a user** — it maps `code` to Indonesian text of its own (`TASKS` `PF-20`). `details` appears only on validation failures, keyed by field, from `zod`'s `flatten().fieldErrors`.

**Planned** (`TASKS` `P6-24`): an optional `reason` — a stable `SCREAMING_SNAKE` identifier refining `code` where one code covers several user-facing refusals (for example `LEAVE_SELF_APPROVAL` under `CONFLICT`) — with its parameters in `details`, and validation `details` carrying issue codes and bounds rather than sentences. Login failures stay a single `INVALID_CREDENTIALS` with no reason (`SECURITY/02` §12).

### Error codes

Defined once in `packages/contracts/src/errors.ts`:

| Code | Status | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body or query fails its schema |
| `INVALID_CREDENTIALS` | 401 | Login failed. Deliberately does not distinguish email, password, or tenant |
| `TOKEN_INVALID` | 401 | Missing, malformed, or unverifiable token |
| `TOKEN_EXPIRED` | 401 | The client refreshes |
| `TOKEN_STALE` | 401 | Access version changed. The client refreshes and retries |
| `TOKEN_REUSE_DETECTED` | 401 | A rotated refresh token was used again — treated as theft |
| `MODULE_NOT_SUBSCRIBED` | 402 | P8 |
| `PERMISSION_DENIED` | 403 | P9 |
| `TENANT_MISMATCH` | 403 | `X-Tenant-ID` disagrees with the token |
| `TENANT_SUSPENDED` | 403 | Tenant is `SUSPENDED` or `CHURNED` |
| `ACCOUNT_SUSPENDED` | 403 | User account suspended |
| `NOT_FOUND` | 404 | On the auth service, also returned for a known path with the wrong method and for `/internal/*` without its secret — a `405` or `403` would confirm the path exists. (Next.js route handlers in `web` answer an unexported method with its default `405`.) |
| `CONFLICT` | 409 | Concurrency or state conflicts: a second approval, a closed period, a duplicate tenant code |
| `ACCOUNT_LOCKED` | 423 | Too many failed logins, with `retry-after` |
| `RATE_LIMITED` | 429 | Per-address or per-tenant limits, with `retry-after` |
| `INTERNAL` | 500 / 503 | Uncaught error (500); overload, auth service unreachable, or not ready (503) |

`410 Gone` is also used, without a dedicated code, for an archived employee document: the row survives, the file does not.

## 7. Idempotency and Concurrency

There is no generic `Idempotency-Key` header. Idempotency is designed per operation where a retry is likely:

| Operation | Mechanism | A repeat returns |
|---|---|---|
| Punch (including offline queue replay) | Client-generated `dedupeKey`, unique per tenant | `200 { "duplicate": true }` |
| Attendance machine import | Row-level duplicate detection | `insertedRows: 0, duplicateRows: N` |
| Payroll run for a period | Partial unique index (cancelled runs excluded) | `409 CONFLICT` |
| Leave approval | `SELECT … FOR UPDATE` on the balance row, validation after the lock (`packages/core/src/leave/balance.ts`); 50 concurrent approvals → exactly 1 succeeds | `409 CONFLICT` |
| Year-start leave carry-over | Idempotent worker job (`apps/worker/src/leave-carry-over.ts`) | no duplicate movement |

## 8. Lists and Limits

There is **no uniform pagination convention**. List endpoints cap their result size individually (the review queue returns at most 100 rows). This has been adequate at pilot scale and is recorded as a gap, not a decision — see `TASKS/BACKLOG.md`.

There is **no API versioning**, and **no public API is planned** (ADR-032, 2026-09-14). The only consumer is this repository's frontend, deployed with the backend. A versioning policy becomes necessary only if a separately deployed client or an SSO integration appears.

## 9. Known Contract Defects

Found while writing this document. Each has a `TASKS/BACKLOG.md` entry; none is fixed here.

- **The client address is taken from the first `X-Forwarded-For` entry**, which the client controls. Behind the reference nginx (`ops/proxy/proxy-common.inc`, `$proxy_add_x_forwarded_for`) the real address is appended *after* whatever the client sent. Per-address rate limits and office-network verification both read that first entry; the correct `X-Real-IP` the proxy sets is only a fallback. In the default Compose topology `web` is published without any proxy, so both headers are client-supplied. See `SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md` §4.
- **The OpenAPI document covers 14 of 100 tenant routes** in prose, and the comment in `openapi.ts` describes a CI test refusing an undocumented route that **does not exist**.

## 10. API Documentation Is Generated, Never Hand-Written

`apps/web/src/lib/openapi.ts` builds an OpenAPI 3.1 document from `ROUTE_MANIFEST` plus a `DOCS` map of summaries and Zod schemas. Paths, methods, authentication, permission, module, and rate limits are **derived**; only prose and request/response schemas are listed by hand, because a Next.js route module may not export its schema.

| Endpoint | Guard | State |
|---|---|---|
| `GET /api/openapi.json` | `core.settings.manage` | Built — **to be removed** in favour of the control-plane route below |
| `GET /admin/api/docs/openapi.json` | Superuser session **and** `X-Docs-Key` | Designed (ADR-031), not built — `TASKS` `P6-18.3` |
| Interactive documentation page under `/admin` | Same; key entered in the page and held in memory | Designed, not built |
| The docs key | One platform-wide secret, set by `ops/scripts/set-docs-key.mjs`, stored as an Argon2id hash in `platform.api_docs_keys`, two valid during rotation | Designed, not built |

**If you change an endpoint, change its manifest entry and its `DOCS` entry.** Never write API reference prose anywhere else.

## 11. Message Language

**Decided 2026-09-14 by the user** (ADR-030): everything the backend produces — API responses, error `message` values, validation messages, logs, debug output — is **English**. The frontend is **fully Indonesian** and supplies its own text for every error it shows.

Today the backend is mixed: commits `a13cfca` (2026-09-01) and `5d99226` (2026-09-13) translated part of it, and about 237 Indonesian string literals remain by a rough search. Completing the backend is `TASKS` `P6-24`; the frontend catalogue is `PF-20`. **Emails and push notifications are Indonesian** (ADR-034): they are composed by the backend but read by people outside the frontend. They too are restored in `P6-24`.
