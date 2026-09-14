# Backlog — Open Questions, Plan Gaps, Deviations, Deferrals

Four kinds of entry:

- **Open Questions (OQ)** — decisions the documents do not contain. **Raised with the user, never resolved unilaterally.** Each carries a recommendation so the decision is quick.
- **Plan Gaps (PG)** — something the plan implies but does not specify, or states wrongly. Each needs a plan amendment or a documented decision.
- **Deviations (DV)** — where the built system differs from the plan. Each has an ADR.
- **Deferred (DF)** — explicitly out of scope now, recorded so the decision is not quietly reversed.

Every entry names what it blocks or affects.

Created 2026-09-13. On 2026-09-14 the user answered `OQ-01`, `OQ-03`, and `OQ-11`; `OQ-04` and `OQ-10` fell away as a consequence of `OQ-03`. The rest have not been discussed yet.

---

## Open Questions

### ~~OQ-01 — Language of API error messages~~ — ANSWERED 2026-09-14

**Answer (the user)**: *English for the system — API responses, error messages, logs, debugging output, and everything else the backend produces. The frontend is fully Indonesian.*

Recorded as ADR-030, superseding ADR-023. Consequences:

- The API `message` field is **for developers and logs**, not for end users. `a13cfca` and `5d99226` translated part of it; the rest — about 237 Indonesian string literals in about 77 backend files by a rough search — follows (`P6-24`).
- **The frontend never renders a server `message`.** It maps the error `code` — and a finer-grained reason where one code covers several refusals — to Indonesian text of its own (`PF-20`). About 30 places render the server message today.
- The frontend's own English strings (in `apps/web/src/lib/push.ts` and the fallback in `session.tsx`, from `5d99226`) go back to Indonesian (`PF-20`).
- **Interpretation, stated so it can be corrected**: data the frontend displays — seeded menu labels, leave-type names, holiday names — counts as frontend content and stays Indonesian. Emails and push notifications reach users outside the frontend and are currently English; that one is asked separately as `OQ-15`.

### OQ-02 — Where do off-host backups go, and who holds the PII keys?

**Blocks**: `P6-17`. **Affects**: risk `F4`, `docs/PLAN/20` §6–7, `docs/SECURITY/04` Playbook 4.

Every backup — dump, storage archive, WAL — is on the database host. `PII_ENCRYPTION_KEY` is in no backup at all, by design; losing it destroys every encrypted national ID, tax ID, and bank account permanently.

**Recommendation**: an S3-compatible bucket in an Indonesian region for backups, encrypted client-side; the PII keys held in a password manager by two named people, separately from the backups.

### ~~OQ-03 — Is SSO/SAML (or a public API) actually on the roadmap?~~ — ANSWERED 2026-09-14

**Answer (the user)**: *For now, gating stays in backend logic for multi-tenant access. SSO may be implemented in the future. There is no public API.*

Recorded as ADR-032. Consequences, per `docs/PLAN/14` §12 S8 ("if SSO and a public API are not on the roadmap, stop after stage 5"):

- Authorization stays **in-process** in the backend (`decideAccess`). The auth service (`apps/auth`, stage 6) and the broker (stage 7) stay built, tested, and **off**; `AUTH_SERVICE_URL` and `BROKER_URL` stay unset in production.
- Stages 1–5 stay: they fixed real defects and do not depend on the split.
- `PS-10` (mTLS), `PS-11` (stage 8), and `PS-12` (remote authorization cost) are `BLOCKED` by `DF-11` (a decision to adopt SSO).
- **Ed25519 stays**; RS256 is revisited only if SSO is adopted.
- `OQ-04` and `OQ-10` are no longer needed.
- `PG-02` (API versioning) is only needed for the internal API between this frontend and backend.

### ~~OQ-04 — One database instance or two for auth?~~ — NOT NEEDED (2026-09-14)

Only relevant if auth runs as a separate service. It does not (`OQ-03`). One database.

### ~~OQ-05 — Capacity assumptions~~ — ANSWERED 2026-09-14

**Answer (the user)**: *about 3 companies in the first year, with fewer than 200 monitored employees.*

Recorded as ADR-033. **Interpretation**: "fewer than 200" most likely means in total; the envelope is sized for the looser reading — up to 200 per company, **600 employees** — so it holds either way.

| First-year envelope | Value |
|---|---|
| Tenants | 3 |
| Monitored employees | ≤ 600 (≤ 200 per tenant) |
| Morning peak | ≤ 600 punches, with photos, assumed bunched into **15 minutes** |
| Load test target (3×) | 1,800 punches with photo uploads in 15 minutes (≈ 2 punches/s, ≈ 4 requests/s including uploads), plus a burst of 100 offline replays arriving at once, with the live dashboard open for each tenant |

Consequences: `P6-21` is no longer blocked by this question, and drops to **P3** — the volume is far below every limit measured in `docs/PLAN/18` §2; `P0-11` (5,000-row import spike) drops to **P3**, since no tenant has more than 200 employees; one small host is enough (`docs/PLAN/20`); risks F9, R17, and N7 are re-rated. The envelope is revisited at the first tenant beyond it.

### OQ-06 — Who receives alerts, and who owns security?

**Blocks**: `P6-16`. **Source**: `docs/SECURITY/03` §Alert Routing.

No on-call rotation, paging tool, or named security owner exists.

**Recommendation**: one named owner and a Telegram or email channel to start; a paging tool when there is a paying tenant.

### OQ-07 — Retention period for employee documents

**Blocks**: `P2-10`. **Source**: `docs/PLAN/13` §5 Technical debt.

Document expiry reminders exist; deletion does not, deliberately. The period is legal (tax records under the General Tax Provisions Law, employment records under manpower law), not technical.

**Recommendation**: ask a legal adviser; until then keep documents.

### OQ-08 — Gate C: who is the payroll expert, and when?

**Blocks**: every `BLOCKED` card in `PHASE-5-PAYROLL.md`. **Source**: `docs/PLAN/12` §6 Gate C.

**Recommendation**: do not engage before Gate B (one paying tenant) is met — Gate B is the stronger signal.

### OQ-09 — Log shipping vendor

**Source**: `docs/PLAN/14` §13.5, §9.3; risk `S6`. **Affects**: `P6-16`.

Logs are redacted but PII-adjacent; shipping them abroad is a PDP Act question.

**Recommendation**: self-hosted (Loki or similar) on the same provider as the database until a legal review says otherwise.

### ~~OQ-10 — Does the control plane deploy with auth or separately?~~ — NOT NEEDED (2026-09-14)

Auth is not deployed separately (`OQ-03`); the control plane stays inside `apps/web`.

### ~~OQ-11 — API documentation access: the secret header~~ — ANSWERED 2026-09-14

**Answer (the user)**: follow the recommendation.

Recorded as ADR-031; spec `MEMORY/specs/P6-18-api-documentation-access.md` updated to *Reviewed*. Decided:

1. **One platform-wide secret**, known to the platform operator.
2. **Set by an `ops` script** that generates it, prints it once, and stores it — no screen.
3. **Rotation**: two secrets valid at once, the older with an expiry.
4. **Stored as an Argon2id hash**, not reversible encryption — the secret is only ever verified, so a database dump plus the application's keys still cannot reveal it. (The original request said "encrypt"; hashing was recommended as the stronger form and accepted.)
5. **Guards both** the interactive page and the OpenAPI JSON.
6. **Access requires a platform superuser session and the header** — the documentation moves to the control plane; the tenant route `GET /api/openapi.json` is removed.
7. **The key is entered in the page and held in memory only**, sent as a header on the JSON request.

### OQ-12 — Recovery objectives (RPO / RTO)

**Source**: `docs/PLAN/20` §7. **Affects**: `P6-17`.

**Recommendation**: RPO 15 minutes (WAL archiving already allows it), RTO 4 hours, both revisited at the first paying tenant.

### OQ-13 — Subscription credit for owners of the reference Excel product

**Blocks**: `P6-11`. **Source**: `docs/PLAN/12` §6 Phase 6, `docs/PLAN/04` §13. Commercial terms, not engineering.

### OQ-14 — HS256 retirement date

**Blocks**: `PS-08`. **Source**: `docs/PLAN/14` §6, §10.1.

**Recommendation**: remove `JWT_SECRET` from every environment as soon as the EdDSA keys are deployed everywhere; the hybrid window has no remaining purpose once no HS256 token can still be unexpired (15 minutes).

### OQ-15 — Language of emails and push notifications

**Affects**: `P6-24`, `PF-20`. **Raised**: 2026-09-14, from the answer to `OQ-01`.

Emails (invitations, password reset, contract and document reminders) and push notifications (leave decisions) are read by employees and HR, but outside the frontend. `a13cfca` translated them to English. The answer to `OQ-01` covers "the system" (English) and "the frontend" (Indonesian); these sit between the two.

**Recommendation**: Indonesian — the reader is the same Indonesian HR officer or employee who sees the frontend, and an English password-reset email looks like phishing to them. Until decided, they stay as they are.

---

## Plan Gaps

### PG-01 — No pagination convention

`docs/PLAN/15` §8. List endpoints cap results individually (review queue: 100). Adequate at pilot scale. **Needed before**: any tenant with more than a few hundred employees.

### PG-02 — No API versioning policy

`docs/PLAN/15` §8. There is no public API (`OQ-03`, 2026-09-14), so the only consumer is this repository's own frontend, deployed together with the backend. Needed only if a separately deployed client (a native app, stage 8) or SSO integration appears.

### PG-03 — `docs/PLAN/13` is stale in places

Last updated 28 August 2026; says "there is no PITR yet" while `ops/RUNBOOK.md` §7 records PITR as configured and verified. **Action**: a pass over `PLAN/13` §5 to strike what later commits closed. Not done in the documentation work of 2026-09-13 so that `PLAN/13` stays the build's own record.

### PG-04 — `openapi.ts` claims a coverage test that does not exist

The comment in `apps/web/src/lib/openapi.ts` describes a CI test refusing an undocumented route. None exists; 14 of 100 routes are documented. **Resolved by**: `P6-18.1`.

### PG-05 — `docs/PLAN/01` and `04` do not say they are superseded

Both describe a 16-service Kubernetes architecture. `docs/PLAN/12` §3 replaced it, and `docs/README.md` says so, but the documents themselves carry no notice. **Action**: a one-line superseded notice at the top of each — a deliberate edit, awaiting approval.

### PG-06 — The Phase 0 and Phase 1 environment was never built as planned

`docs/PLAN/12` Phase 0 and 1 name CI, staging, managed PostgreSQL, Sentry, and an uptime check. None exists. Recorded as `DV-09`; the work is `P0-09`, `P0-10`, `P1-13`, `P1-14`.

---

## Deviations

| ID | Plan says | Built | ADR | Status |
|---|---|---|---|---|
| DV-01 | Gates A and B before Phases 3 and 4 (`12` §6) | Phases 3–6 built with neither gate met | ADR-016 | Open — gates still to be tested |
| DV-02 | Gate C before the first line of payroll (`12` §6) | The payroll framework built; statutory rules not | ADR-015 | Open — statutory work blocked until Gate C |
| DV-03 | Tiered leave approval (`12` Phase 4) | Single step, manager preselected | ADR-014 | Accepted until a customer defines the second approver (`13` §2.4) |
| DV-04 | Advisory lock per employee for leave (`12` Phase 4, `03` §4.1) | `SELECT … FOR UPDATE` on the balance row | ADR-014 | Accepted — same guarantee, proven by the 50-approval test |
| DV-05 | Socket.IO + Redis for real time (`01`) | SSE over `LISTEN`/`NOTIFY`, polling fallback | ADR-011 | Accepted (`13` §2.3) |
| DV-06 | Per-vendor attendance machine adapters (`04` R8) | Generic CSV/Excel import | ADR-013 | Accepted (`13` §2.6, `12` Phase 3) |
| DV-07 | AG Grid 33 | AG Grid 36 | — | Accepted (`13` §2.2) |
| DV-08 | No tenant time zone in any plan | Tenant and site time zones | ADR-012 | Accepted — an addition (`13` §2.1) |
| DV-09 | CI, staging, managed PostgreSQL, Sentry, uptime check (`12` Phases 0–1) | None | — | Open — `P0-09`, `P0-10`, `P1-13`, `P1-14` |
| DV-10 | Split services only when `12` §9 triggers fire | Auth split built ahead of the triggers | ADR-017 | Accepted, with `12` §9.1 amended |
| DV-11 | Photos uploaded by presigned URL to object storage (`10` §4.1) | Uploaded through the server to a volume | ADR-025 | Accepted — EXIF can only be guaranteed stripped on the server |
| DV-12 | Workbox service worker (`12` Phase 3) | Hand-written `public/sw.js` | ADR-026 | Accepted — verified by `service-worker.test.ts` |
| DV-13 | Next.js 15 (`12` §3.2) | Next.js 16 | ADR-008 | Accepted |
| DV-14 | Managed S3-compatible object storage (`12` §3.2) | Local disk behind a `BlobStore` interface | ADR-027 | Accepted — files on the host volume (risk F4) |

---

## Deferred

| ID | Item | Waits for | Source |
|---|---|---|---|
| DF-01 | Tiered leave approval | A customer who defines the second approver | `13` §2.4 |
| DF-02 | Anniversary-based leave balance periods | A tenant using `ANNIVERSARY` | `13` §5 Leave |
| DF-03 | Per-vendor attendance machine connectors | Demand from a paying tenant | `12` Phase 3 |
| DF-04 | Face matching | A PDP Act review and separate consent (R45) | `10` §5.3 |
| DF-05 | Periodic tax filing, official BPJS recap, accounting journal | Phase 6+ demand | `12` Phase 5 |
| DF-06 | Distributed tracing (OpenTelemetry) | Someone collecting traces | `13` §5 Observability |
| DF-07 | Phase 7+ modules | Gate D | `12` §6 Phase 7+ |
| DF-08 | Native mobile app | A PWA limit a tenant cannot accept | `11` §2.4 |
| DF-09 | Malware scanning of uploads | A paying tenant or a compliance requirement | `SECURITY/02` §11 |
| DF-10 | Unsaved-changes warnings on long forms | — | `UI-UX/12` §6 |
| DF-11 | SSO (OIDC/SAML) and enabling the separate auth service (`PLAN/14` stages 6–8) | A decision to adopt SSO | `OQ-03`, ADR-032 |
| DF-12 | A public API for third parties | Not planned (the user, 2026-09-14) | `OQ-03`, ADR-032 |

---

## Security Findings of 2026-09-13

Found while writing `docs/SECURITY/`. Each is a risk in `docs/PLAN/22` and a task; listed here so they are visible in one place.

| Risk | Finding | Task | Priority |
|---|---|---|---|
| F1 | `X-Forwarded-For` first entry trusted: office-network verification and per-address rate limits bypassable | `P3-12` | **P0** |
| F5 | No CSP, HSTS, `X-Content-Type-Options`, frame-ancestors | `P6-12` | P0 |
| F11 | Unmasked PII viewed in employee list/detail writes no audit row | `P2-08` | P0 |
| F12 | No permission ceiling for role and grant administrators | `P6-13` | P1 |
| F13 | Superuser TOTP secrets in plaintext; superuser logins not audited | `P6-14` | P1 |
| — | Internal secret compared with `!==` | `P6-15` | P2 |
| F2 | No CI: no dependency or secret scanning | `P0-09` | P0 |
| F3 | No alerting | `P6-16` | P1 |
| F4 | All backups on-host; PII keys in no backup | `P6-17` | P1 |
| — | No automated test for self-approval refusal, account lockout, login timing | `P4-08`, `P6-20` | P1 |
| S1 | HS256 still verifies; the compose example configures it | `PS-08` | P1 |
