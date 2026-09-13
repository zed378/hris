# 00 — Asset and Trust Boundary Inventory

What this system holds that is worth protecting, and every line across which trust changes. Every scenario in `02-ATTACK-SURFACE-AND-SCENARIOS.md` names an asset and a boundary from here by id.

Inventoried against the code on 2026-09-13. The controls listed are summaries; `../PLAN/17-SECURITY-BASELINE.md` says where each is enforced.

---

## Asset Inventory

| Id | Asset | Where it lives | Why it matters | Classification |
|---|---|---|---|---|
| A-1 | Employee identity PII: national ID (NIK), tax ID (NPWP), bank account | `employee.employees`, AES-256-GCM ciphertext + blind index | Identity theft, payroll fraud; PDP Act breach notification | **Restricted** |
| A-2 | Other employee records: name, contact, position, contracts, documents | `employee.*`, document storage volume | Personal data under the PDP Act | Confidential |
| A-3 | Attendance evidence: selfies, GPS coordinates, client address | `attendance.punch_logs`, photo storage volume | Location is surveillance-grade data (P15); photos are biometric-adjacent | **Restricted** |
| A-4 | Payroll: salary structures, components, runs, payslips | `payroll.*` | Pay confidentiality between colleagues; fraud; wrong pay is a trust incident | **Restricted** |
| A-5 | Leave: balances, requests, medical attachments | `leave.*`, attachment storage volume | Attachments may carry health data | Confidential |
| A-6 | Credentials: Argon2id password hashes, refresh token hashes, action token hashes | `auth.*` | Account takeover | **Restricted** |
| A-7 | Token signing keys: `JWT_PRIVATE_JWK`, `ADMIN_JWT_PRIVATE_JWK`, `JWT_SECRET` | Environment of `web` / `auth` | Anyone holding one can mint a session for any user of any tenant | **Critical secret** |
| A-8 | PII encryption and index keys: `PII_ENCRYPTION_KEY`, `PII_INDEX_KEY`, old key rings | Environment of `web` / `worker` | Decrypts A-1 for every tenant; losing it destroys A-1 | **Critical secret** |
| A-9 | Superuser accounts and TOTP secrets | `platform.superusers` — **TOTP secret stored in plaintext** | Control-plane takeover | **Restricted** |
| A-10 | Roles, permissions, grants, menus, access versions | `iam.*` | Integrity: a changed grant is an authorization bypass | Integrity-critical |
| A-11 | Subscriptions and entitlements | `tenant.*`, `platform.*` | Revenue; P8 enforcement | Integrity-critical |
| A-12 | Audit trails | `audit.audit_logs`, `platform.platform_audit_logs`, `attendance.photo_access_logs` | The evidence in any investigation | Integrity-critical |
| A-13 | Tenant registry: tenant codes, status, time zones | `tenant.tenants` | Enumeration target; suspension enforcement | Internal |
| A-14 | Service secrets: `AUTH_INTERNAL_SECRET`, `METRICS_TOKEN`, `VAPID_PRIVATE_KEY` | Environment | Authorize RPC impersonation; metrics exposure; push spoofing | Secret |
| A-15 | Backups and WAL archive | `hrms-backups`, `hrms-wal` volumes | A full copy of A-1 through A-12 (ciphertext for A-1) | **Restricted** |
| A-16 | Browser-side state: in-memory access token, offline punch queue (IndexedDB), service worker cache | The employee's device | Shared or lost phones (R50) | Confidential |
| A-17 | Push subscriptions | `push_subscriptions` | Notification delivery to a device | Internal |

## Trust Boundaries

| Id | Boundary | Crossed by | What must be re-established on the far side |
|---|---|---|---|
| TB-1 | Internet → reverse proxy / `web` | Every browser and PWA request | Identity (token), tenant (token `tid`), input validity |
| **TB-2** | **Reverse proxy → application** | **Forwarded headers: `X-Forwarded-For`, `X-Forwarded-Proto`, `Host`** | **Which header values the proxy wrote, versus which the client sent. Not established today — `02` §4** |
| TB-3 | Gateway → domain code | `defineRoute` → handler | The authorization decision: access version, module, permission (P7, P8) |
| TB-4 | Application → PostgreSQL | `withTenant()` transaction | Tenant context via `set_config`; RLS enforces it (P6) |
| TB-5 | Tenant ↔ tenant inside one database | Every query | RLS `FORCE`, composite tenant FKs, per-tenant `NOTIFY` channels |
| TB-6 | Tenant plane ↔ control plane | `hrms-tenant` vs `hrms-admin` tokens; `hrms_app` vs `hrms_platform` roles | Separate audience, key realm, and database grants (P11) |
| TB-7 | `web` → `auth` service (split topology) | `POST /internal/authorize`, proxied `/api/auth/*` | `x-internal-secret`; correlation id. Shared secret, not mTLS |
| TB-8 | Request path → background work | Outbox, pg-boss, NATS | Tenant id carried in the envelope; the worker re-enters `withTenant` |
| TB-9 | Device → server | Punch payloads: coordinates, accuracy, photo, client timestamp, `dedupeKey` | **Everything the device reports is a claim.** Scored, never trusted (P14) |
| TB-10 | Application → file storage | Photos, documents, leave attachments | Type from magic bytes; path from server-generated keys; access logged |
| TB-11 | External files → import pipeline | Employee Excel, attendance machine CSV | Per-row validation in staging; PII never plaintext in staging |
| TB-12 | Operator / host → running system | Environment files, `docker compose`, backups, `psql` as owner | Everything. The host operator holds A-7, A-8, A-15 |
| TB-13 | Application → outbound services | Email, Web Push | No tenant data beyond what the message needs |

## Boundary Diagram

```
                 ┌────────────── TB-9: device claims ──────────────┐
  Browser / PWA ─┤  token in memory, offline queue, service worker │
                 └───────────────────────┬──────────────────────────┘
                                         │ TB-1
                                  ┌──────▼──────┐
                                  │   nginx     │  appends to X-Forwarded-For
                                  └──┬───────┬──┘
                           TB-2      │       │      TB-2
                              ┌──────▼──┐  ┌─▼───────┐
                              │  web    │──│  auth   │  TB-7 internal secret
                              │ gateway │  └────┬────┘
                              └──┬──────┘       │
                     TB-3 ───────┤              │
                              ┌──▼──────────────▼──┐     TB-8     ┌────────┐
                              │ PostgreSQL (RLS)   │◄────────────►│ worker │
                              │ TB-4 / TB-5 / TB-6 │              └────────┘
                              └────────────────────┘
                     TB-10: storage volume     TB-12: host operator
```

## How to Use This Document

- A feature that stores a new kind of data adds an asset row, and classifies it, in the same change.
- A feature that adds a new way for data to enter or leave adds or amends a boundary row.
- A **Restricted** or **Critical secret** asset touched by a change makes that change security-sensitive: a spec in `MEMORY/specs/` and an abuse-case test are mandatory (`../PLAN/23-FEATURE-SPECIFICATION-TEMPLATE.md`).
