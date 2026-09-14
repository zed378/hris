# 04 — Incident Response Playbooks

What to do, in order, when a security incident is suspected. Operational incidents — a slow database, stopped jobs, a failed migration — are in [`../../ops/RUNBOOK.md`](../../ops/RUNBOOK.md); this document covers incidents where data or trust is at stake, and links to the runbook where the technical steps already exist.

**None of these playbooks has been rehearsed.** The backup restore and PII key rotation they depend on have been (`RUNBOOK` §6, §8.3).

---

## General Principles (Apply to Every Playbook)

1. **Contain first, investigate second, fix third.** A leak that continues while you investigate is a bigger leak.
2. **Preserve evidence before changing anything.** Take a database backup (`ops/scripts/backup.sh`) and copy container logs off the host before rotating, revoking, or restoring. A restore overwrites the evidence.
3. **Write a timeline as you go** — UTC and WIB, who did what. It becomes the record in `MEMORY/records/` and, if personal data was involved, the basis for notification.
4. **Personal data involved → the PDP Act clock starts at awareness.** Law 27/2022 requires notifying data subjects and the authority within **3 × 24 hours** of becoming aware of a failure of personal data protection. Scope the affected tenants and subjects early; the notification itself goes through each **tenant** as data controller — this system is their processor.
5. **Do not fix a guard by loosening it.** If a test or constraint blocks the fix, the fix is wrong.
6. **Every incident ends with a regression test** that would have caught it, seen to fail against the vulnerable code.

---

## Playbook 1: Cross-Tenant Exposure

**Trigger:** a user reports seeing another company's data; D-1 fires; a test shows a leak.

1. **Contain.** If `schema_drift_report()` shows `bypass_rls`: `ALTER ROLE hrms_app NOBYPASSRLS;` (and `hrms_worker`, `hrms_auth`, `hrms_platform`). If `rls_missing`: enable and force RLS with the standard policy immediately (`RUNBOOK` §3). If the cause is a handler, disable the route by removing it from `ROUTE_MANIFEST` and redeploying — the gateway refuses unregistered routes.
2. **Preserve.** Backup; logs.
3. **Scope.** Which tables, which tenants, which time window. `audit.audit_logs` for reads that were audited; metrics per route for request volume; the migration history for when the table or role changed.
4. **Notify** the affected tenants (principle 4).
5. **Fix and prove.** A test in `tenant-isolation.test.ts` or `gateway.test.ts` reproducing the leak, failing before the fix.
6. **Find how it got there** — `RUNBOOK` §3 step 3. Manual DDL and half-applied migrations are the usual causes.

## Playbook 2: Personal Data Breach

**Trigger:** PII (A-1, A-3, A-5) seen outside its authorized audience: in logs, in a leaked backup, in an export sent to the wrong person, through `02` §8.

1. **Contain** the channel: revoke the export link or file share; rotate `METRICS_TOKEN` if metrics leaked; remove leaked logs where possible.
2. **Preserve.**
3. **Determine what was exposed as plaintext.** A database dump exposes A-1 only as ciphertext — **unless** `PII_ENCRYPTION_KEY` was exposed too. Decide which case you are in before deciding scope.
4. **If the key may be exposed:** rotate `PII_ENCRYPTION_KEY` and `PII_INDEX_KEY` following `RUNBOOK` §8 (rehearsed). Note §8.5: rotating the index key has different rules.
5. **Notify** within 3 × 24 hours (principle 4).
6. **Fix and prove.** If logs carried PII, extend the redaction test in `logger.test.ts` with the exact shape that leaked.

## Playbook 3: Signing Key Compromise

**Trigger:** `JWT_PRIVATE_JWK`, `JWT_SECRET`, or `ADMIN_JWT_*` exposed — committed, in a leaked environment file, or on a compromised host.

1. **Contain.** Generate a new key pair (`node ops/scripts/generate-jwt-keys.mjs`). Deploy with the new private key and **only** the new public key in `JWT_PUBLIC_JWKS`. If `JWT_SECRET` was exposed, **unset it** — this also ends the HS256 hybrid window (`../PLAN/14` §10.1).
2. Every outstanding access token now fails verification; clients refresh. Refresh tokens are opaque and stored hashed — they are not affected by a signing key leak and need no revocation for this cause alone.
3. **Scope.** Tokens forged during the exposure window are indistinguishable by signature. Review `audit.audit_logs` for actions by unusual actors or at unusual times in that window.
4. **For the admin realm:** also review `platform_audit_logs`, and re-enrol superuser TOTP if the host was compromised (TOTP secrets are plaintext in the database — `02` §9).

## Playbook 4: PII Encryption Key Lost

**Trigger:** `PII_ENCRYPTION_KEY` is gone — a host lost without the environment file backed up anywhere.

There is no recovery. Every encrypted national ID, tax ID, and bank account is unreadable, permanently (`../PLAN/20-DEPLOYMENT-AND-DISASTER-RECOVERY.md` §7).

1. Confirm no copy exists anywhere: other hosts, a password manager, a deployment secret store, an old backup of the environment file.
2. Inform affected tenants: the fields must be re-collected from source documents.
3. Generate a new key; existing ciphertext stays unreadable and must be overwritten by re-entry or re-import.
4. Record this as a Critical incident — and treat it as the reason to build key escrow before the next one (`F4`).

## Playbook 5: Credential Stuffing or Account Takeover

**Trigger:** D-3 fires; users report logins they did not make; lockouts spike.

1. **Contain.** If distributed from a recognisable source, block at the proxy. If `02` §4 is still open, do not rely on per-address limits — the attacker may be rotating `X-Forwarded-For`; block on the proxy's `$remote_addr`, which the client cannot set.
2. **For confirmed compromised accounts:** force a password reset; revoke refresh token families; bump the user's access version so outstanding access tokens go stale within one request.
3. **Scope** each compromised account's actions from `audit.audit_logs`.
4. **Notify** the tenant's owner. If the compromised account held PII access, go to Playbook 2.

## Playbook 6: Attendance Fraud at Scale

**Trigger:** a tenant reports systematic false punches; `OFFICE_IP_VERIFIED` punches from employees known to be remote; the flagged ratio drops suddenly without a policy change.

1. **Contain.** Advise the tenant to switch `FALLBACK_ONLY` to `BLOCK` until `02` §4 is fixed — `BLOCK` does not depend on the client address.
2. **Scope.** Punches with `OFFICE_IP_VERIFIED` in the window. Each punch row records the address the application saw — which, today, may be the spoofed one.
3. **Remediate.** Return the scoped punches to the review queue. **Do not** delete or silently re-score them: the attendance record is the tenant's evidence, and history is never overwritten (P13).
4. **Fix** `02` §4, with the verification tests named there.

## Playbook 7: Secret or Dependency Compromise

**Trigger:** a secret committed to git; a published advisory for a dependency in `pnpm-lock.yaml`; a compromised base image.

1. **Committed secret:** rotate it first — removing it from history does not un-leak it. Then Playbooks 3 or 2 depending on which secret.
2. **Malicious dependency:** assume every secret in the affected container's environment is exposed (A-7, A-8, A-14). Pin the last good version, rebuild, rotate all of them.
3. **Vulnerable dependency:** assess reachability; upgrade; run `pnpm verify`.
4. Record which detection would have caught it earlier — today, none (`02` §18).

## Playbook 8: A Guard Was Weakened

**Trigger:** review finds a loosened test assertion, a route made `public`, a removed RLS policy, an eslint rule disabled — by a person or an AI agent.

1. **Revert** the weakening.
2. **Check whether it shipped** and for how long. If it did, treat the window as the matching scenario in `02` and use the playbook for it.
3. **Record** in `MEMORY/records/`, including how it got past review.
4. **Add** the guard's own failure test if it did not have one (`../PLAN/16-TESTING-STRATEGY.md` §1 rule 4).
