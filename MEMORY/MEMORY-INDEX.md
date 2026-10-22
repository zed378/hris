# Memory Index

Every record, newest first. One line each: date, task, record, and the hook that tells you whether it is the one you need.

Add a line here when writing a record — an unindexed record is a record nobody finds. *(reconstructed)* marks records written after the work (`README.md` § Reconstructed Versus Contemporaneous).

---

## Records

| Date | Task | Record | Hook |
|---|---|---|---|
| 2026-10-22 | P6-18.2 | [Every route documented](./records/2026-10-22-api-documentation.md) | 86 routes given English OpenAPI prose written from their handlers; each behavioural claim checked against the code, one corrected |
| 2026-10-21 | P6-18.1 | [OpenAPI coverage test](./records/2026-10-21-openapi-coverage-test.md) | The test that names every route without `DOCS` prose; written failing with 86 |
| 2026-10-21 | PF-01 | [UI component audit](./records/2026-10-21-ui-components.md) | The shared components checked against `docs/UI-UX/06`; no change needed |
| 2026-10-22 | P6-14 | [Superuser TOTP and login audit](./records/2026-10-22-superuser-totp.md) | TOTP secrets sealed under a control-plane key ring; every superuser login audited, unknown emails without the address typed. Found: superuser email enumeration by latency, and a Compose file with no PII keys at all |
| 2026-10-22 | PF-02 | [Mobile navigation](./records/2026-10-22-mobile-navigation.md) | Bottom bar plus drawer below `md`, chosen by menu code, never by path. Replaced a draft that hard-coded five paths and whose "Keluar" did not log out. Checked in Chromium at 360 px; real device still pending |
| 2026-10-22 | P6-13 | [Permission ceiling](./records/2026-10-22-permission-ceiling.md) | A delegate holding `iam.role.manage` could add any permission to their own role, or empty `TENANT_OWNER` and lock the owner out — the test proved the lockout. Now only the owner confers beyond what they hold; ADR-035 |
| 2026-10-21 | P6-12 | [Browser security headers](./records/2026-10-21-security-headers.md) | `apps/web/next.config.ts` now sets CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and HSTS on every response; `apps/web/test/security-headers.test.ts` asserts the real config. Closes risk F5 in `PLAN/22` |
| 2026-10-21 | P2-08 | [Audit unmasked PII reads](./records/2026-10-21-pii-audit.md) | Every unmasked NIK/NPWP/bank-account read through the employee list or detail now writes an `employee.pii.unmasked` row — actor, tenant, employee ids, field names, IP, correlation id, never a value. Closes the High gap in `PLAN/17` §9 and abuse case (e) in `SECURITY/02` §8 |
| 2026-09-14 | — | [Answers to OQ-01, OQ-03, OQ-11](./records/2026-09-14-open-question-answers.md) | Backend English, frontend Indonesian and never showing server messages; API docs behind a superuser and a hashed key; the auth split stops. Two new tasks, one new question (emails and push), and the capacity question rewritten because it was unclear |
| 2026-09-13 | — | [Documentation set](./records/2026-09-13-documentation-set.md) | `docs/PLAN/15–23`, `SECURITY/`, `UI-UX/`, `TASKS/`, `MEMORY/`, `CLAUDE.md`, `AGENTS.md`. Seventeen findings recorded and not fixed — the worst a client-controlled address that defeats office-network verification. Also a table of sixteen claims I wrote and the code contradicted |
| 2026-09-13 | — | [Two AI tools in one working tree](./records/2026-09-13-concurrent-agent-commits.md) | A build broken by nobody's intended edit, a test failing on translated prose, a product decision (the language users read) made by a translation pass, and a comment claiming a test that did not exist. Why commits stage explicit paths |
| 2026-09-13 | — | [Move `PLAN/` under `docs/PLAN/`](./records/2026-09-13-docs-plan-move.md) | 145 files rewritten, verified by reversing the substitution: 0 real differences. Why the numbers were kept rather than matched to `zed-auth` |
| 2026-09-13 | PS-01–PS-14 | [Service split, stages 1–7](./records/2026-09-13-service-split-stages-1-7-summary.md) *(reconstructed)* | An index to `docs/PLAN/14` §10. The access version that was never compared, rate limits multiplied by replicas, a bad token reported as an outage. What is on and what is opt-in |
| 2026-09-13 | P0–P6 | [Phases 0–6 build summary](./records/2026-09-13-phases-0-6-build-summary.md) *(reconstructed)* | What 89 commits between 2026-08-18 and 2026-09-01 delivered, per phase DoD with evidence; Gates A–C not met; eight silent bugs from `docs/PLAN/13` §4 and what fixed them |

## Specifications

| Task | Spec | Status |
|---|---|---|
| P6-18 | [API documentation: coverage, interactive page, secret-header access](./specs/P6-18-api-documentation-access.md) | Reviewed 2026-09-14 (ADR-031) |
| P3-12 | [Take the client address from the trusted proxy](./specs/P3-12-trusted-client-address.md) | Draft — decisions in §6, §10, §21 |
