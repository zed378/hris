# Backlog — Open Questions, Plan Gaps, Deviations, Deferrals

Four kinds of entry:

- **Open Questions (OQ)** — decisions the documents do not contain. **Raised with the user, never resolved unilaterally.** Each carries a recommendation so the decision is quick.
- **Plan Gaps (PG)** — something the plan implies but does not specify, or states wrongly. Each needs a plan amendment or a documented decision.
- **Deviations (DV)** — where the built system differs from the plan. Each has an ADR.
- **Deferred (DF)** — explicitly out of scope now, recorded so the decision is not quietly reversed.

Every entry names what it blocks or affects.

Created 2026-09-13. None of the open questions below has been discussed with the user yet; the user asked for them to be recorded and discussed later.

---

## Open Questions

### OQ-01 — Language of API error messages

**Blocks**: nothing hard; **affects** every error line users see, `docs/UI-UX/13` §1, task `PF-04`.

The product interface is Indonesian. API error `message` values were Indonesian throughout the build; commits `a13cfca` (2026-09-01) and `5d99226` (2026-09-13), from another tool's translation pass, translated many of them to English across `apps/auth`, `apps/web`, and `packages/core`, alongside documentation and comments. The standing instruction was "documentation, comments, and README in English" — and the root `README.md` already states the boundary explicitly: *"Do not translate user-facing strings, error messages, seed data, or leave-type names."* The translation commits contradicted the project's own written rule.

**Today a user can see an English error inside an Indonesian page.**

**Options**: (a) messages are Indonesian — revert the translated messages; (b) messages are English and the frontend maps `code` to Indonesian text; (c) messages are English and shown as-is.

**Recommendation**: (a). The `message` field is written for the user (`docs/PLAN/15` §6) and the users are Indonesian. Option (b) is sound but is a larger change with no user benefit over (a). Until decided: **translate nothing further in either direction.**

### OQ-02 — Where do off-host backups go, and who holds the PII keys?

**Blocks**: `P6-17`. **Affects**: risk `F4`, `docs/PLAN/20` §6–7, `docs/SECURITY/04` Playbook 4.

Every backup — dump, storage archive, WAL — is on the database host. `PII_ENCRYPTION_KEY` is in no backup at all, by design; losing it destroys every encrypted national ID, tax ID, and bank account permanently.

**Recommendation**: an S3-compatible bucket in an Indonesian region for backups, encrypted client-side; the PII keys held in a password manager by two named people, separately from the backups.

### OQ-03 — Is SSO/SAML (or a public API) actually on the roadmap?

**Blocks**: `PS-11` (stage 8), the RS256-vs-Ed25519 choice. **Source**: `docs/PLAN/14` §13.1–2.

`docs/PLAN/14` §3 argues the auth split on the grounds that SSO and a public API are coming. Stages 1–7 are built. If neither is coming, §12 S8 says to stop after stage 5 — the split container can stay opt-in and unused.

**Recommendation**: decide before any further split work. If no: keep Ed25519, leave `AUTH_SERVICE_URL` unset in production, drop stage 8.

### OQ-04 — One database instance or two for auth?

**Source**: `docs/PLAN/14` §13.3. **Affects**: `PS-09`, `PS-11`.

**Recommendation**: one (§4.2's own recommendation). Two turns tenant registration into a saga.

### OQ-05 — Capacity assumptions

**Blocks**: `P6-21` (load test), host sizing. **Source**: `docs/PLAN/18` §5.

No expected tenant count, concurrent users, punches per minute at 08:00, or payroll runs per month is written anywhere.

**Recommendation**: state a first-year envelope — e.g. 50 tenants, 5,000 employees, 3,000 punches in the 07:30–08:30 WIB window — and load-test at 3× it.

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

### OQ-10 — Does the control plane deploy with auth or separately?

**Source**: `docs/PLAN/14` §13.6. **Affects**: `PS-11`. **Recommendation**: separately — different audience, different risk; it already has its own database role.

### OQ-11 — API documentation access: the secret header

**Blocks**: `P6-18.3`. **Source**: user request, 2026-09-13 session.

The user asked for API documentation (Swagger UI) available only to a logged-in administrator **and** requiring an additional header carrying a secret the user sets, stored encrypted in the database. Undecided details:

1. Per tenant, or one platform-wide secret? (An administrator of a tenant vs. the platform operator.)
2. Set through a screen, or through a CLI/`ops` script?
3. Rotation: can two secrets be valid during rotation?
4. Encryption: reuse the PII key ring (`packages/core/src/employee/pii.ts`), or hash it (Argon2id) since it only needs verifying? **Hashing is stronger for a verify-only secret** — encryption means the application can recover it.
5. Does the header also guard `GET /api/openapi.json`, or only the UI page?

**Recommendation**: one platform-wide secret, set by an `ops` script, stored as an Argon2id hash with a creation date, two active at once during rotation, guarding both the JSON and the UI. Draft spec: `MEMORY/specs/P6-18-api-documentation-access.md`.

### OQ-12 — Recovery objectives (RPO / RTO)

**Source**: `docs/PLAN/20` §7. **Affects**: `P6-17`.

**Recommendation**: RPO 15 minutes (WAL archiving already allows it), RTO 4 hours, both revisited at the first paying tenant.

### OQ-13 — Subscription credit for owners of the reference Excel product

**Blocks**: `P6-11`. **Source**: `docs/PLAN/12` §6 Phase 6, `docs/PLAN/04` §13. Commercial terms, not engineering.

### OQ-14 — HS256 retirement date

**Blocks**: `PS-08`. **Source**: `docs/PLAN/14` §6, §10.1.

**Recommendation**: remove `JWT_SECRET` from every environment as soon as the EdDSA keys are deployed everywhere; the hybrid window has no remaining purpose once no HS256 token can still be unexpired (15 minutes).

---

## Plan Gaps

### PG-01 — No pagination convention

`docs/PLAN/15` §8. List endpoints cap results individually (review queue: 100). Adequate at pilot scale. **Needed before**: any tenant with more than a few hundred employees.

### PG-02 — No API versioning policy

`docs/PLAN/15` §8. Needed before any external API consumer (`docs/PLAN/14` §2.4).

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
