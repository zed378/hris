# P6-14 — Superuser TOTP sealed; superuser logins audited

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Task** | `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` § P6-14 |
| **Phase** | Phase 6 |
| **Surface** | backend, db, ops |
| **Author** | Agent (Claude Code) |
| **Commits** | `P6-14: seal superuser TOTP secrets; audit every superuser login` |
| **Spec** | `MEMORY/specs/P6-14-superuser-totp-and-login-audit.md` |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

- TOTP secrets are AES-256-GCM-sealed under `PLATFORM_ENCRYPTION_KEY`. Plaintext secrets still verify, and are sealed on login or by `pnpm --filter @hrms/core platform:seal-totp`.
- Every superuser login is in `platform_audit_logs` with a reason. A failure with an unknown email is recorded without the address that was typed.
- `packages/core/src/crypto/` holds the key ring and envelope that used to be private to `employee/pii.ts`.

## Found Along the Way

1. **Superuser email enumeration by latency.** For an unknown email, `superuserLogin` returned before running argon2. That was fast enough to tell which addresses exist. It now burns the same argon2 cost.
2. **No PII keys in `ops/docker-compose.yml`.** The web and worker containers had none, so a Compose deployment failed on every encrypted employee field. Both now require them, using `:?`, so a missing key stops `docker compose up` instead of breaking at the first employee read.
3. **A stale comment in `pii.ts`.** It named `ops/scripts/rotate-pii-keys.mjs`, a file that does not exist. The rotation is in fact `pnpm --filter @hrms/worker pii:rotate`, and the comment now says so.

## Verification

- `apps/web/test/superuser-login.test.ts` goes through the real admin login handler and reads the column as `hrms_owner`. All seven cases failed against the previous `superuser-auth.ts` and pass now.
- The PII tests (52) pass after the envelope extraction.
- `docker compose config` validates with the keys set and refuses without them.
- `pnpm verify` was run locally. There is no CI run for this change.

## Notes

- `apps/web` gained `otplib` as a dev dependency, so the test can generate real codes. Adding it re-linked `@prisma/client` under a new peer hash, and `pnpm install` repaired the stale link in `packages/db`.
- The sweep script runs with `--experimental-transform-types` and so cannot run on Node 26 (`PG-07`). It was tested through its function, not its script entry point.
