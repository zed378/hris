# P6-14 — Encrypt Superuser TOTP Secrets; Audit Superuser Logins

Status: **Implemented** — see `MEMORY/CHANGELOG.md` 2026-10-22
Task: `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` P6-14
Plan refs: `docs/SECURITY/02` §9(c), `docs/SECURITY/03` D-8, `docs/PLAN/06`, `docs/PLAN/17` §4, risk F13

---

## 1. Business Objective

A superuser's TOTP secret is the second factor. Stored in plaintext, anyone who can read `platform.superusers` — a backup, a replica, an over-broad grant — mints valid codes forever. Superuser logins left no trace, so a stolen credential could be used unnoticed. Done when the column holds ciphertext and every login, success or failure, is in `platform.platform_audit_logs`.

## 2. Actors

Platform operators (superusers), the operator running the deployment, an attacker holding a database copy or guessing credentials.

## 3. Functional Requirements

- **FR1** TOTP secrets are stored AES-256-GCM-sealed under a control-plane key ring, `PLATFORM_ENCRYPTION_KEY` (write) / `PLATFORM_ENCRYPTION_KEYS_OLD` (read), separate from the PII ring.
- **FR2** Plaintext secrets (every superuser before this change) still verify, so nobody is locked out by the deploy.
- **FR3** A successful login seals a plaintext secret, or re-seals one written by a demoted key.
- **FR4** `pnpm --filter @hrms/core platform:seal-totp` seals every remaining plaintext secret and re-seals demoted ones; re-runnable.
- **FR5** Every login writes a platform audit row: `superuser.login.succeeded`, or `superuser.login.failed` with `detail.reason` ∈ `unknown_email`, `inactive`, `password`, `totp`, and the client address.
- **FR6** The response to every failure is unchanged: one `401 INVALID_CREDENTIALS`.
- **FR7** An unknown email pays the same argon2 cost as a known one.

## 4. Non-Functional Requirements

One AES-GCM operation per login; one extra insert. No latency target applies.

## 5. Dependencies

New environment variable `PLATFORM_ENCRYPTION_KEY`, required by the web container (`ops/docker-compose.yml`) and set in CI.

## 6. Database Changes

`platform.platform_audit_logs.superuser_id` loses `NOT NULL` (migration `20261022090000_platform_audit_login_attempts`): an unknown-email failure has no superuser. Relaxing a constraint is additive (P12). The `CHECK` requiring a secret on active superusers is unchanged; a sealed secret satisfies it.

## 7. API Contract

`POST /admin/api/auth/login`: unchanged request and responses.

## 8. Frontend Changes

Not applicable — no visible change.

## 9. Backend Changes

- `packages/core/src/crypto/` — the key ring and AES-GCM envelope, extracted from `employee/pii.ts`, which now wraps it.
- `packages/core/src/platform/totp-secret.ts` — `sealTotpSecret`, `readTotpSecret`, `sealTotpSecrets`.
- `superuser-auth.ts` — reads through `readTotpSecret`, seals on success, audits every outcome, burns argon2 for unknown emails.

## 10. Authorization Rules

Unchanged. `hrms_platform` already holds `INSERT` on the audit table and `UPDATE` on `superusers`.

## 11. Validation

Unchanged.

## 12. Error Handling

A sealed secret with `PLATFORM_ENCRYPTION_KEY` unset or wrong throws and the login fails with 500 — loudly, because a silent fallback would be a lockout nobody can diagnose. Plaintext secrets keep working without the key until sealed.

## 13. Edge Cases

- A superuser created by hand with a plaintext secret after the sweep: sealed on first login, or by re-running the sweep.
- Key rotation: promote the new key, demote the old one to `_OLD`, run the sweep, remove the old key.

## 14. Abuse Cases

- A database read of `platform.superusers` (§9(c)) yields ciphertext.
- Credential guessing against the control plane leaves `superuser.login.failed` rows.
- Superuser address enumeration by latency (found during this task) is closed by FR7.

## 15. Logging and Audit

FR5. An unknown email is recorded **without** the address typed: that field is where a superuser pastes a password by mistake, and the audit trail must not keep it.

## 16. Security Controls

Closes F13. Gives D-8 (`docs/SECURITY/03`) its signal.

## 17. Testing Strategy

`apps/web/test/superuser-login.test.ts` through the real admin login handler, reading the column as `hrms_owner`. All seven cases fail against the previous code.

## 18. Acceptance Criteria

The card's DoD.

## 19. Definition of Done

Tests pass and were seen to fail; `docs/PLAN/17` §4, `docs/SECURITY/02` §9, `docs/SECURITY/03` D-8, risk F13 updated; runbook §8a.

## 20. Implementation Sequence

Envelope extraction → TOTP module → login changes → migration → tests → configuration → docs.

## 21. Rollback Strategy

Reverting the code after secrets were sealed locks superusers out — the old code reads the sealed value as a base32 secret. Before reverting, unseal: run `readTotpSecret` over each row with the key present. The migration needs no rollback.

## 22. Technical Risks

Losing `PLATFORM_ENCRYPTION_KEY` locks every superuser out; recovery is re-enrolling TOTP by hand in the database. It belongs in the key escrow `P6-17` decides.
