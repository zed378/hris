# P3-12 — Take the Client Address From the Trusted Proxy

Status: **Draft** — sections 6, 10, 21 carry decisions for review
Task: `TASKS/PHASE-3-ATTENDANCE-PWA.md` P3-12
Plan refs: `docs/SECURITY/02` §4, `docs/PLAN/15` §4 and §9, `docs/PLAN/23` worked example, `docs/PLAN/20` §1, `ops/proxy/proxy-common.inc`, risk F1

---

## 1. Business Objective

The address a request came from decides three things: whether a browser punch counts as made from the office (removing the `WEB_UNVERIFIED_DEVICE` penalty and satisfying `FALLBACK_ONLY`), which per-address rate-limit bucket a login or public request counts against, and the IP written to audit rows. Today a client chooses it. Done when no client-supplied header can change any of the three.

## 2. Actors

Sari and Joko (employees punching), Mbak Dewi (HR relying on `OFFICE_IP_VERIFIED` in the review queue), an anonymous attacker attempting credential stuffing, the reverse proxy, the operator configuring a deployment.

## 3. Functional Requirements

- **FR1** One function decides the client address for `apps/web` (tenant and control planes) and `apps/auth`.
- **FR2** Behind a trusted reverse proxy, the address is the one the proxy observed, never a value the client supplied.
- **FR3** With no trusted proxy configured, forwarding headers are ignored.
- **FR4** A missing or malformed address never fails a request: office verification treats it as no match; rate limiting uses a single shared "unknown" bucket; audit rows record null.
- **FR5** The decision is testable without a running proxy.

## 4. Non-Functional Requirements

No added latency (header parsing only). No change to response shapes. Works identically in the in-process and split topologies.

## 5. Dependencies

`ops/proxy/nginx.conf` and `proxy-common.inc`; `ops/docker-compose.yml` port publishing; environment configuration; `normaliseClientIp` in `packages/core/src/attendance/office-network.ts`.

## 6. Current State and Design — **decision required**

### Current state

All three call sites read:

```ts
x-forwarded-for?.split(',')[0]?.trim() ?? x-real-ip
```

| Topology | What reaches the application | Trustworthy? |
|---|---|---|
| **Default** (`docker compose up`): `web` published directly on `${WEB_PORT:-3000}` | Whatever headers the client sends | **Neither header** |
| **`split` profile**: nginx in front, `proxy_set_header X-Real-IP $remote_addr` and `X-Forwarded-For $proxy_add_x_forwarded_for` | `X-Real-IP` = the real peer; `X-Forwarded-For` = `<client-supplied>, <real peer>` | `X-Real-IP` **yes**; first XFF entry **no** |

So the reference proxy already sends the right value — in `X-Real-IP` — and the code reads the wrong one first.

### Options

| | Option | For | Against |
|---|---|---|---|
| A | Read **only `X-Real-IP`**, and only when `TRUST_PROXY=true` | The proxy already sets it; one line to reason about; not spoofable through nginx because `proxy_set_header` overwrites any client value | Must be overwritten by every proxy in the chain; a CDN in front needs its own header (e.g. `CF-Connecting-IP`) |
| B | `TRUSTED_PROXY_HOPS=n`: take the *n*th entry from the **right** of `X-Forwarded-For` | Standard; works through multiple proxies | Easy to misconfigure: one hop too many trusts the client again |
| C | Read the socket peer address | Unspoofable | Next.js route handlers do not expose it; behind any proxy it is the proxy's address |

**Recommendation: A**, with `TRUST_PROXY` defaulting to `false`. With `false`, the address is `unknown` (FR3, FR4) — which in the default topology means office verification never matches and all per-address limits share one bucket. That is the honest result for a deployment with nothing trustworthy in front of it, and the readiness endpoint should report it (§15), as it already reports `rateLimit` and `signing`.

The default Compose topology should put the proxy in front of `web` rather than publishing `web` directly — a separate decision for `docs/PLAN/20`, noted as a follow-up.

## 7. API Contract

No route changes. `GET /api/ready` gains a reported fact: `"clientAddress": "trusted-proxy" | "untrusted"`. No new error codes.

## 8. Frontend Changes

None. The work site form's help text about office networks should say that verification needs a trusted proxy (a copy change in `/attendance/sites`).

## 9. Backend Changes

- A `clientAddress(headers, env)` function in a package both apps can import (e.g. `packages/observability` beside the request context, or a new `packages/http`). Not in `packages/core`, whose domain code should not read HTTP headers.
- `apps/web/src/lib/define-route.ts`, `define-admin-route.ts`, `apps/auth/src/http.ts` call it.
- The backend forwarding to `apps/auth` passes the decided address in an internal header, and `apps/auth` trusts that header **only** on requests carrying a valid `x-internal-secret` — otherwise `apps/auth` applies the same function to its own inbound headers.

## 10. Authorization Rules

Not an authorization change. **Decision required:** whether an office-network match should additionally require `clientAddress: trusted-proxy` at the tenant level — i.e. a tenant cannot select `FALLBACK_ONLY` on a deployment where the address is untrusted. Recommended: yes; the settings screen explains why the option is unavailable.

## 11. Validation

The chosen header value passes through `normaliseClientIp` (IPv4-mapped IPv6, zone index, `isIP`). Anything rejected → `unknown`. Multiple values in `X-Real-IP` → `unknown`.

## 12. Error Handling

No request fails because of the address. A misconfiguration (`TRUST_PROXY=true` with no `X-Real-IP` present) logs a `warn` once per process, not per request.

## 13. Edge Cases

- Requests from inside the Compose network (health checks) have no `X-Real-IP`.
- IPv6 clients; IPv4-mapped IPv6 from a dual-stack proxy.
- A CDN or load balancer in front of nginx: `$remote_addr` becomes the CDN's address; `set_real_ip_from` is required and documented.
- Punches already recorded with `OFFICE_IP_VERIFIED` (§21).
- The offline queue replaying hours later: the address is the replay's, not the punch's — already true, and correct: the claim is about the connection.

## 14. Abuse Cases

| Scenario | `SECURITY/02` | Expected |
|---|---|---|
| Employee sends `X-Forwarded-For: <office>` through nginx | §4(a) | Ignored; office match fails |
| Employee sends `X-Real-IP: <office>` through nginx | §4(a) | Overwritten by nginx; fails |
| Employee sends either header directly to `web` in the default topology | §4(a) | `TRUST_PROXY=false` → `unknown`; no match |
| Attacker rotates `X-Forwarded-For` on each login attempt | §4(b), §2(a) | Same bucket every time |
| Forged address in audit rows | §4(c) | Audit records the proxy-observed address or null |
| Client sends the internal forwarded-address header to `apps/auth` without the secret | §10 | Ignored |

## 15. Logging and Audit

Audit `ip` from the new function. Readiness reports `clientAddress`. A one-time `warn` for misconfiguration (§12). No per-request logging of addresses beyond what exists.

## 16. Security Controls

Relies on: nginx overwriting `X-Real-IP` (`proxy_set_header`), `proxy_set_header X-Internal-Secret ""` already stripping the internal header from clients, `normaliseClientIp`. Adds: a trust switch defaulting to distrust.

## 17. Testing Strategy

- **Unit** — `clientAddress` for every row of §14 and §13.
- **Integration, through the real handlers** — `defineRoute` for `POST /api/attendance/punch` with a tenant whose site has an office range: spoofed `X-Forwarded-For` → the punch is flagged and, under `FALLBACK_ONLY`, refused. Rate-limited public route with rotating headers → `429` after the limit. The same for `apps/auth`'s login over real HTTP, and one admin route.
- **Proxy** — extend `ops/proxy-test` to send spoofed headers through the real nginx and assert what the upstream receives.
- **Seen to fail** — the integration tests run against the current code first and fail.

**Which test fails if this breaks silently?** The punch integration test with a spoofed header.

## 18. Acceptance Criteria

- Every row of §14 passes, through the real request path.
- `/api/ready` reports `clientAddress` correctly in both topologies.
- `docs/SECURITY/02` §4 status → Mitigated; risk F1 closed; `docs/PLAN/15` §9 updated; `docs/PLAN/23` worked example updated.

## 19. Definition of Done

Task DoD in `TASKS/PHASE-3-ATTENDANCE-PWA.md` P3-12, plus the global DoD.

## 20. Implementation Sequence

1. Failing integration tests for §14 against current code.
2. `clientAddress` with unit tests.
3. Replace the three call sites; tests pass.
4. Internal forwarded-address header between `web` and `auth`.
5. Readiness fact; misconfiguration warning.
6. `.env.example`, `ops/docker-compose.yml` (`TRUST_PROXY` on `web` and `auth` in the `split` profile), `docs/PLAN/20` §4.
7. `ops/proxy-test` spoofing case.
8. §21 remediation, if decided.
9. Documentation updates.

## 21. Rollback Strategy — **decision required**

Code-only; reverting restores current behaviour. No migration.

**Existing data:** punches recorded with `OFFICE_IP_VERIFIED` since migration `20260901090000` (2026-09-01) cannot be re-verified. Options: (a) leave them; (b) a one-off script listing them per tenant for the tenant to review; (c) return them to the review queue automatically. Recommended: **(b)** — history is not rewritten (P13), and whether to re-review is each tenant's decision. On a database with no real tenants, nothing to do.

## 22. Technical Risks

F1 (closed by this), R47, R43; a CDN in front making `$remote_addr` wrong (§13) — documented in `docs/PLAN/20`.
