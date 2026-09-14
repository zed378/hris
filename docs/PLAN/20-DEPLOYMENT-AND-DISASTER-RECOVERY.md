# 20 — Deployment and Disaster Recovery

How the system is packaged, started, migrated, backed up, and recovered. The step-by-step procedures live in [`../../ops/RUNBOOK.md`](../../ops/RUNBOOK.md); this document states the shape, the order, and the guarantees — and which of them have been rehearsed.

`01-Architecture-Tech-Stack.md` §8 describes a Kubernetes deployment for sixteen services. That is **not** what exists. `12-Small-Team-Execution-Plan.md` §3.2 replaced it with Docker Compose on a single host, deliberately.

---

## 1. Topology

One Compose file, `ops/docker-compose.yml`. Services are added by **profile**, so the default stack stays as small as `12` §3.2 intends.

| Service | Image | Profile | Role |
|---|---|---|---|
| `wal-init` | `postgres:18-alpine` | default | Makes the WAL archive volume writable by `postgres` — without it archiving fails silently (`RUNBOOK` §7) |
| `postgres` | `postgres:18-alpine` | default | The one database: a schema per module, RLS on, pg-boss queue |
| `migrate` | built | default | Runs Prisma migrations, then online migrations; exits. Everything else waits for it to **complete successfully** |
| `redis` | `redis:8-alpine` | default | Shared rate limits and the permission cache. Fail-open (`14` §10.3) |
| `web` | `ops/Dockerfile.web` | default | Pages and every tenant/control-plane endpoint |
| `worker` | `ops/Dockerfile.worker` | default | Background jobs; serves no HTTP |
| `nats` | `nats:alpine` | `broker` | Opt-in broker (`BROKER_URL`); pg-boss otherwise (`14` §10.7) |
| `auth` | `ops/Dockerfile.auth` | `split` | The auth service (`AUTH_SERVICE_URL`) |
| `proxy` | `nginx:alpine` | `split` | Routes `/api/auth/*` and JWKS to `auth`, everything else to `web` |
| `backup` | `postgres:18-alpine` | `backup` | Scheduled logical backups |

```bash
docker compose -f ops/docker-compose.yml up --build                         # default
docker compose -f ops/docker-compose.yml --profile split --profile broker up  # split + NATS
```

Development does **not** use this file: `pnpm db:up` starts PostgreSQL and Redis from `ops/docker-compose.dev.yml`, and the apps run on the host with hot reload.

## 2. Start Order Is Enforced, Not Hoped For

```
wal-init ─► postgres (healthy) ─► migrate (completed successfully) ─► web, worker, auth
                                                          redis (started) ─┘
```

A web container that starts before migrations finish serves requests against a schema it was not built for. `depends_on: condition: service_completed_successfully` on `migrate` is what prevents it; a failed migration stops the deploy instead of half-running it.

## 3. Database Roles

Created by `ops/initdb/01-roles.sql` and re-asserted by migrations on every deploy:

| Role | Used by | May |
|---|---|---|
| `hrms_owner` | `migrate` only | Own tables, run DDL |
| `hrms_app` | `web` | Tenant data under RLS |
| `hrms_worker` | `worker` | Tenant data under RLS, longer statement timeout |
| `hrms_platform` | control plane | `platform.*` and `tenant.*`; **no** grant on `auth.users`, `iam.*`, `audit.*` |
| `hrms_auth` | `auth` | `auth.*`, the identity parts of `iam.*` |

Every runtime role is `NOBYPASSRLS`. Production DDL credentials belong to the migration runner alone (R37).

## 4. Configuration

All configuration is environment variables. The complete list with explanations is [`.env.example`](../../.env.example); the Compose-specific subset is `ops/.env.compose.example`.

| Group | Variables | If wrong |
|---|---|---|
| Database | `DATABASE_URL`, `DATABASE_URL_APP`, `_WORKER`, `_PLATFORM`, `_AUTH` | A runtime process connecting as `hrms_owner` bypasses nothing (FORCE RLS), but can run DDL |
| Tenant tokens | `JWT_PRIVATE_JWK`, `JWT_PUBLIC_JWKS`, `JWT_SECRET` | `JWT_SECRET` set keeps HS256 verification alive (`17` §9) |
| Control-plane tokens | `ADMIN_JWT_*` | Must differ from the tenant realm |
| Personal data | `PII_ENCRYPTION_KEY`, `PII_INDEX_KEY`, `*_KEYS_OLD` | **Losing `PII_ENCRYPTION_KEY` loses every encrypted national ID, tax ID, and bank account.** It is not in the database backup |
| Platform | `REDIS_URL`, `BROKER_URL`, `AUTH_SERVICE_URL`, `AUTH_INTERNAL_SECRET` | Each unset means the in-process fallback; readiness reports which |
| Storage | `PHOTO_STORAGE_DIR`, `DOCUMENT_STORAGE_DIR`, `LEAVE_ATTACHMENT_STORAGE_DIR` | Files are on a volume, not in PostgreSQL — see §6 |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` | Unset → emails are **printed to the log, not sent** (`packages/core/src/notification/transport.ts`). Invitations and password resets never arrive, with no error to the user. Commented out in `.env.example` |
| Other | `METRICS_TOKEN`, `VAPID_*`, `APP_BASE_URL`, `COOKIE_SECURE` | — |

`ops/.env.compose.example` configures HS256 (`JWT_SECRET`) and not the EdDSA keys. A deployment copied from it runs on the legacy signing path — tracked in `TASKS/`.

Generate keys with `node ops/scripts/generate-jwt-keys.mjs` and `node ops/scripts/generate-vapid.mjs`.

## 5. Migrations

Two runners, one order:

1. **Prisma migrations** (`packages/db/prisma/migrations/`) — transactional, additive only (P12), each with `SET LOCAL lock_timeout`. `pnpm lint:migrations` refuses destructive statements before they run.
2. **Online migrations** (`packages/db/prisma/migrations-online/`) — work that cannot run in a transaction, chiefly `CREATE INDEX CONCURRENTLY` on hot tables. Re-runnable; the runner reports INVALID indexes left by a failed build.

Rollback is **forward-only**. Because migrations never drop or rename, the previous application image still runs against the new schema; rolling back is redeploying the previous image, never reversing a migration. A failed migration mid-way is `RUNBOOK` §4.

## 6. Backup

| What | How | Rehearsed |
|---|---|---|
| Database, logical | `ops/scripts/backup.sh` → `pg_dump` custom format; `backup` profile runs it daily at 02:15 | Yes — 28 Aug 2026, 160 MB / 261,000 punches: backup 2 s, restore 5 s, row counts identical (`RUNBOOK` §6) |
| Database, continuous | WAL archiving + `ops/scripts/basebackup.sh` | Yes — point-in-time recovery verified (`RUNBOOK` §7) |
| Uploaded files (photos, documents, leave attachments) | **Not covered by either backup** | — |
| PII encryption keys | **Not covered.** Kept outside the database by design | — |
| Redis | Not backed up; nothing in it is authoritative | — |

A restore must be followed by the checks in `RUNBOOK` §6 "What MUST be checked after a restore" — above all, that every runtime role is still `NOBYPASSRLS` and `schema_drift_report()` returns nothing.

## 7. Recovery Objectives

**No RPO or RTO has been agreed.** What the rehearsed mechanisms can deliver, stated so that one can be chosen:

| Scenario | Mechanism | Achievable data loss | Achievable downtime |
|---|---|---|---|
| Bad deploy | Redeploy previous image | None | Minutes |
| Accidental data change by a tenant | PITR into a side instance, extract rows | Up to the WAL archive's last segment | Hours, manual |
| Database host lost | Logical restore **or** base backup + WAL | Since the last backup (≤ 24 h), or last archived segment with PITR | Hours, manual |
| Storage volume lost | — | **All photos and documents** | — |
| PII key lost | — | **All encrypted PII fields, permanently** | — |

The last two rows are the reason this section exists. Tracked in `TASKS/BACKLOG.md`.

## 8. Not Built

| Missing | Consequence |
|---|---|
| A CI pipeline that builds and pushes images | Images are built on the deploying host; `Dockerfile.web` and `Dockerfile.worker` have no recorded build in automation |
| Off-host backup copies | A backup on the same host as the database does not survive the host |
| Secret management | Secrets are environment files on the host |
| High availability | One PostgreSQL, one host. The 99.5% target in `12` §11 is achievable with fast manual recovery, not with failover |
| TLS termination | Expected in front of `proxy`/`web`; not configured in this repository |
| A production deployment record | Nothing in this repository shows the system running in production |
