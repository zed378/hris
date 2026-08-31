# Incident Runbook

The five incidents most likely to happen, how to recognise them, and what to do.
Written to be read at two in the morning by someone who did not write the code.

Rules that apply to every procedure below:

- **Do not delete data to restore service.** Rule M4 of document `09`. Almost
  every incident here has a way out that deletes nothing.
- **Do not grant `BYPASSRLS` to an application role**, not even temporarily. The
  daily drift job will find it, but between two checks the whole tenant
  isolation stops applying.
- **Write down what you are doing** in the incident channel as you do it, not
  afterwards. The person who resolves an incident is usually not the one who
  writes the report.

---

## 1. The application is slow or hanging

**Symptoms.** Pages take a long time to load. Logs contain `{"scope":"overload"}`
or 503 responses. Users report "the system is slow", not an error.

**Check this first, before anything else:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<host>/api/health   # process alive?
curl -s http://<host>/api/ready                                     # database reachable?
```

`health` 200 but `ready` 503 means the application is alive and the database is
the problem — and in that state **do not restart the application**. A restart
does not fix the database, and every instance coming back up immediately opens a
fresh connection pool against a database that is already overwhelmed.

**Most common cause.** The transaction pool is exhausted — usually one tenant
running a large import, or one query scanning a table without an index.

**Diagnosis.**

```sql
-- Running queries, longest first.
SELECT pid, usename, state, now() - query_start AS duration, left(query, 120)
FROM pg_stat_activity
WHERE state <> 'idle' AND query NOT LIKE '%pg_stat_activity%'
ORDER BY query_start;

-- Idle transactions holding locks.
SELECT pid, usename, now() - state_change AS idle_for, left(query, 80)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change;
```

**Actions.**

1. The `hrms_app` role has a 15-second `statement_timeout`, so user queries cut
   themselves off. Anything running longer almost certainly belongs to
   `hrms_worker` (5-minute limit) or `hrms_owner` (no limit).
2. If one query is clearly the cause, cancel the **query** only:
   `SELECT pg_cancel_backend(<pid>)`. Use `pg_terminate_backend` only when
   `pg_cancel_backend` does not work — it drops the connection, and any running
   transaction is rolled back.
3. If the cause is one tenant flooding, its quota (600 requests per minute)
   already holds part of it back. The `{"scope":"tenant-quota"}` log names the
   `tenantId`.
4. After recovery: find that slow query in the logs and **add its index**. The
   same incident will return on the next working day.

---

## 2. Background jobs stopped — flagged punches never arrive, email is not sent

**Symptoms.** Worker logs contain `{"scope":"outbox","stuck":N}` with N rising,
or the worker produces no logs at all.

**Diagnosis.**

```bash
pnpm --filter @hrms/worker outbox:retry     # lists what is stuck, changes nothing
```

```sql
SELECT topic, count(*), min(last_error)
FROM messaging.outbox_messages
WHERE published_at IS NULL AND attempts >= 10
GROUP BY topic;
```

**Actions.**

1. Read `last_error`. A cause that has actually happened: **the pg-boss queue
   was never created** for a topic. That means the topic is missing from the
   `EventTopic` catalogue — now impossible because of its type, but check
   anyway.
2. Fix the cause first. Returning messages to the queue before the cause is gone
   just burns another ten attempts.
3. Once the cause is gone:
   `pnpm --filter @hrms/worker outbox:retry <topic>`
4. **Do not delete outbox rows.** A lost message means a punch that was never
   reviewed or an email that was never sent, with no trace.

---

## 3. Tenant isolation has leaked

**Symptoms.** Someone reports seeing data that is not theirs. Or the daily drift
job reports `{"scope":"schema-drift","severity":"critical"}`.

**This is the most serious incident on this list.** Treat it as a data breach.

**Diagnosis.**

```sql
SELECT * FROM public.schema_drift_report();
```

Three findings can appear:

| `kind` | Meaning | Consequence |
|---|---|---|
| `rls_missing` | A table with `tenant_id` and no RLS | **Every tenant reads every other tenant's data** |
| `policy_missing` | RLS enabled with no policy | The table denies everything — the module is dead |
| `bypass_rls` | An application role can bypass RLS | All isolation stops applying |

**Actions.**

1. For `bypass_rls`, immediately: `ALTER ROLE hrms_app NOBYPASSRLS;`
2. For `rls_missing`, install the policy using the same pattern as every other
   table — see any migration that creates a tenant-scoped table.
3. Do not stop at the fix. **Find out how that table came to exist without RLS**:
   almost certainly it was created through psql outside a migration, or a
   migration failed halfway.
4. Determine the scope of the leak from `audit.audit_logs` and the access logs.
   Indonesian Law 27/2022 (UU PDP) requires notifying data subjects.

---

## 4. A migration failed halfway

**Symptoms.** `prisma migrate deploy` fails with `P3009`, and the next deploy
refuses to run.

**Actions.**

1. Read the original error:
   `pnpm --filter @hrms/db exec prisma migrate deploy` — the message names which
   migration failed and on which statement.
2. Check what was ALREADY applied. A migration is not atomic when it contains
   `CREATE INDEX CONCURRENTLY` or several DDL statements.
3. Fix the migration file, then:
   ```bash
   pnpm --filter @hrms/db exec prisma migrate resolve --rolled-back <migration_name>
   pnpm --filter @hrms/db exec prisma migrate deploy
   ```
4. **Do not use `--applied`** to skip it, unless you have confirmed that
   everything in that migration is genuinely already in the database. Marking it
   "applied" when it is not makes the next migration fail in a far more
   confusing way.
5. Remember rule P12: migrations are additive only. If the fix requires a
   `DROP`, the fix is wrong.

---

## 5. Attendance photos are not deleted after their retention period

**Symptoms.** Logs contain `{"scope":"photo-retention","failed":N}`, or files
pile up in `.storage/attendance-photos`.

**Why this is an incident.** Indonesian Law 27/2022 (UU PDP) requires that
personal data is not kept longer than needed. A face photo that outlives its
retention period is an ongoing violation, not a housekeeping issue.

**Diagnosis.**

```sql
SELECT count(*) FROM attendance.punch_logs
WHERE photo_key IS NOT NULL AND photo_expires_at < now();
```

**Actions.**

1. Read the error in the logs. Most likely: file permissions, a full disk, or
   `PHOTO_STORAGE_DIR` pointing somewhere wrong.
2. Check that the storage root really is the same for `apps/web` and
   `apps/worker`. Relative paths resolve against the repository root, not the
   process working directory — if `PHOTO_STORAGE_DIR` holds a relative path in
   only one of them, the two point at different places.
3. The database reference is **deliberately not cleared** when file deletion
   fails. As long as it survives, the next run finds that file again.
4. Once the cause is gone the job recovers on its own next run — nothing needs
   to be triggered by hand.

Note that the retention period is now a tenant setting
(`attendance_policies.photo_retention_days`, default 90). The expiry is computed
**when the photo is stored**, so changing the setting does not move the deadline
for photos already taken.

---

## 6. Restoring from backup

**This procedure has been run and verified**, not assembled from documentation.
The most recent test results are recorded below.

### Taking a backup

```bash
bash ops/scripts/backup.sh ./backups
```

The script verifies the contents, not just that a file exists — a backup that
failed halfway still leaves a file behind, and what separates it from a usable
one is whether its table of contents can be read.

It produces **two** files sharing a timestamp:

| File | Contents |
|---|---|
| `hrms-<stamp>.dump` | The database |
| `hrms-<stamp>-storage.tar.gz` | Attendance photos and employee documents |

Both must be restored as a pair. A database backup without its files will look
complete — every table present, every row present, and `punch_logs.photo_key`
pointing at files that no longer exist. The failure only surfaces when someone
opens an attendance photo to settle a wage dispute.

Retention keeps the last 14 backups, counted by **number** rather than age:
age-based retention would delete everything at once if the job stopped for two
weeks and then ran again. File archives are removed alongside their paired dump.

### Restoring

**Always restore into a NEW database first**, never straight over production.
Restoring an old backup on top of a database that is still healthy is the one
thing worse than having no backup.

```bash
bash ops/scripts/restore.sh backups/hrms-20260828T090736Z.dump hrms_restore
```

The script demands confirmation in the form of **the database name**, not just
"y".

Storage files are restored separately, from the archive with the SAME timestamp:

```bash
tar -xzf backups/hrms-20260828T090736Z-storage.tar.gz -C /path/to/target
```

**Tested end to end:** extracted files are identical down to their SHA-256
hashes, the directory structure is intact, and `storage_key` on
`employee_documents` resolves to the correct path. An archive that has never
been opened is not a backup.

### Scheduling backups

Two ways. Pick one — running both produces two backup series whose retention
policies know nothing about each other, and one of them will delete files it
believes belong to the other.

#### A. Compose service — for a single-VPS deployment

```bash
docker compose --profile backup up -d
```

It sits behind a profile, so it does not start with a plain `docker compose up`.
**It does not mount the Docker socket**: mounting `/var/run/docker.sock` gives
the container full control of the machine — equivalent to root on the host — and
trading that for scheduling convenience is a bad bargain. The service uses
`pg_dump` from inside the PostgreSQL image and connects over the network like
any other client.

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_INTERVAL_SECONDS` | 86400 | Gap between backups |
| `BACKUP_KEEP` | 14 | How many backups to keep |

**Its limitation:** the scheduler is a sleep loop rather than cron, because cron
inside a container needs its own init process, and a container with two
processes makes `docker logs` and stop signals behave strangely. The consequence
is that the schedule **drifts**: if a backup takes five minutes, the next one
starts five minutes later, and after a month it runs nowhere near the intended
time.

For scheduling that has to be punctual, use option B.

#### B. Host cron — for schedules that must be exact

```cron
# Every day at 02:15 local time.
15 2 * * * cd /opt/hrms && bash ops/scripts/backup.sh /var/backups/hrms >> /var/log/hrms-backup.log 2>&1
```

`backup.sh` picks its own mode: direct `pg_dump` when a PostgreSQL client is on
PATH and `PGHOST`/`DATABASE_URL` are set, `docker exec` otherwise. The mode is
printed on the first line of output — a backup script that silently switches
modes is one that works on a laptop and fails on the server.

**A backup that is never checked is not a backup.** Schedule a test restore into
a separate database at least monthly; the procedure is below, and at 160 MB it
finishes in five seconds.

### What MUST be checked after a restore

Data restored without RLS is not a successful restore — it is a leak waiting for
the first request. The script checks this automatically, but check it yourself
before pointing the application at it:

```sql
-- 1. Zero drift findings.
SELECT * FROM public.schema_drift_report();

-- 2. Policy count matches the source database.
SELECT count(*) FROM pg_policies
WHERE schemaname NOT IN ('pg_catalog','information_schema');

-- 3. Isolation actually works. Run as hrms_app, NOT as owner — the owner
--    bypasses RLS, so testing as owner tests nothing.
SET ROLE hrms_app;
SELECT count(*) FROM employee.employees;                      -- must be 0
SELECT set_config('app.tenant_id', '<tenant-uuid>', false);
SELECT count(*) FROM employee.employees;                      -- must match
```

If drift is not zero, run migrations against the restored database before using
it:

```bash
DATABASE_URL=<url-of-restored-database> pnpm --filter @hrms/db exec prisma migrate deploy
```

Migrations are idempotent and additive; they only fill in what is missing.

### Test results — 28 August 2026

Two tests: one on development data, one on data the size of a mid-sized tenant.

#### At realistic size — 500 employees, one year of attendance

| | |
|---|---|
| Database | 160 MB — 261,000 punches, 130,500 daily records, 500 employees |
| **Backup time** | **2 seconds** → an 11 MB dump (compressed from 160 MB) |
| **Restore time** | **5 seconds**, including recreating the database and checking drift |
| Completeness | 261,000 / 130,500 / 500 — identical row for row |
| RLS policies | 47 on the source, 47 on the restore |
| Drift report | 0 findings |

These numbers set the recovery target: **a full restore of a 500-employee tenant
completes in under ten seconds**, so the outage window during a recovery
incident is decided by human judgement, not by the machine.

A rough extrapolation for larger tenants: time is close to linear in row count.
5,000 employees with the same history ≈ 1.6 GB, restoring in about a minute.

#### On development data

| Checked | Result |
|---|---|
| Backup size | 272 KB, 62 tables with data |
| Row counts per table | Identical: audit 272, punches 32, leave 6, payslips 3, calculation traces 15, employees 3, tenants 2 |
| RLS policies | 47 on the source, 47 on the restore |
| Drift report | 0 findings |
| Isolation with no tenant context | 0 rows readable — fail-closed |
| Isolation with the demo context | 3 employees, 32 punches — correct |
| Isolation with another tenant's context | 0 employees, 0 punches, 0 payslips |

### Its limitations, stated plainly

- **Not tested above 160 MB.** The numbers above are linear across the tested
  range, but extrapolation is not measurement. The first tenant to pass one
  gigabyte deserves a fresh measurement.
- **The compose schedule drifts.** See the note on option A above.
- **The scale test used a single storage file.** Archiving tens of thousands of
  attendance photos has not been measured, and `tar` over many small files
  behaves differently from `tar` over one large one.

---

## 7. Point-in-time recovery

Section 6 answers "restore yesterday's backup". This one answers a question that
backup cannot: **"restore the database to 14:32:07, just before that `DELETE`
without a `WHERE` ran."**

Two mechanisms exist because they answer different questions, and neither
replaces the other:

| | `backup.sh` (pg_dump) | `basebackup.sh` + WAL |
|---|---|---|
| Answers | "restore one table", "move to another server" | "restore everything to a specific second" |
| Form | Logical, portable, selective | Physical, version-locked, all or nothing |
| Usable for PITR | **No** | Yes |

Logical dumps and WAL archives **cannot be combined**. WAL describes changes at
the physical block level and only means anything on top of a matching physical
copy.

### How it is configured

`ops/docker-compose.yml` sets `archive_mode=on` and archives WAL segments to a
volume separate from the data volume — an archive sitting on the same volume as
the data would be lost by the same failure that made it necessary.

A `wal-init` service hands that volume to the postgres user before postgres
starts. **This step is not optional and its absence is silent:** a named Docker
volume is owned by root, PostgreSQL runs as uid 70, and `archive_command`
therefore fails without archiving anything. `archive_mode=on` is still set, the
configuration looks correct everywhere anyone checks, and only
`pg_stat_archiver.failed_count` rises.

### Checking that archiving actually works

Do this after any change to the postgres service, and periodically:

```sql
SELECT archived_count, failed_count, last_archived_time, last_failed_wal
FROM pg_stat_archiver;
```

`failed_count` rising with `archived_count` flat means nothing is being
archived. That is the failure mode described above, and PostgreSQL will
**retain** unarchived segments and keep retrying — so the disk fills slowly with
no visible cause.

### Taking a base backup

```bash
bash ops/scripts/basebackup.sh ./backups
```

It writes `backups/base-<timestamp>/` containing `base.tar.gz`,
`pg_wal.tar.gz`, and an `INFO.txt` recording the PostgreSQL version and the LSN.
That file matters: someone restoring six months from now has to know which base
backup precedes their target time, and guessing wrong produces a message about
"requested timeline" that explains nothing at 3am.

Weekly is a reasonable cadence. Two base backups are kept by default
(`HRMS_KEEP_BASE`).

**WAL segments older than the oldest retained base backup can be pruned** —
there is no starting point before them. Segments newer than it must not be
touched; removing them destroys the ability to recover, with no warning.

### Recovering to a point in time

```bash
bash ops/scripts/pitr-restore.sh \
  ./backups/base-20260831T060000Z \
  ./wal \
  "2026-08-31 14:32:07+07"
```

**The target time must carry a timezone.** Without one it is read in the
server's `timezone`, and a server running in UTC restores to a point seven hours
away from what someone in Jakarta meant.

The script builds a **new instance** in its own container and volume on port
5434. It never touches the running database: a restore that overwrites
production cannot be undone, and whether it hit the right point can only be
judged by looking at the result.

```bash
psql -h localhost -p 5434 -U postgres
```

Inspect the data. If the point is wrong, remove the instance and try another
target time — that costs nothing:

```bash
docker rm -f hrms-pitr && docker volume rm hrms-pitr-data
```

### Swapping the recovered instance into production

Only after inspecting the data.

1. **Stop the application**, not just the database. Requests arriving during the
   swap would be written to a database about to be replaced.
   ```bash
   docker compose -f ops/docker-compose.yml stop web worker
   ```
2. **Take a logical backup of the current (damaged) database anyway.**
   ```bash
   bash ops/scripts/backup.sh ./backups
   ```
   This is the step that gets skipped under pressure, and the one that matters
   most: if the recovery point turns out to be wrong tomorrow, this file is the
   only remaining copy of what was lost between the target time and now.
3. **Dump from the recovered instance and load into a fresh database**, rather
   than swapping volumes. Swapping volumes carries the recovery configuration
   along with the data, and an instance that starts in recovery mode with no
   archive to read will refuse to come up.
   ```bash
   pg_dump -h localhost -p 5434 -U postgres -Fc hrms > recovered.dump
   bash ops/scripts/restore.sh recovered.dump hrms_recovered
   ```
4. **Run the post-restore checks in §6** against `hrms_recovered`. Data restored
   without RLS is a leak waiting for the first request.
5. Point `DATABASE_URL` at the recovered database and start the application.
6. **Take a fresh base backup immediately.** The old WAL archive describes a
   timeline that no longer applies.

### Verified

Proven end to end on a throwaway instance, not assembled from documentation:

| Step | Result |
|---|---|
| 500 rows written, base backup taken | base backup created |
| 200 more rows written | 700 rows total, timestamp recorded |
| All 700 deleted | 0 rows — the damage to be undone |
| WAL segments archived | 5 |
| Restored to the second before the delete | **700 rows returned, the deletion did not** |

### Its limitations, stated plainly

- **Maximum data loss is now one WAL segment**, or `archive_timeout` (300
  seconds) on a quiet system — not the 24 hours it was before. It is not zero:
  the last segment is still in flight when the machine dies.
- **The archive is on the same host as the database.** A disk failure takes
  both. Copying `hrms-wal` off-host is the next step and is not yet scripted.
- **Base backups are version-locked.** They can only be restored by the same
  major PostgreSQL version. Moving between versions needs a logical dump.
- **The swap procedure above has not been rehearsed end to end** — only the
  recovery itself has. The steps are written from what the recovery test proved
  plus standard practice, and deserve one rehearsal before they are needed.

---

## 8. Rotating the PII encryption keys

Two keys protect personal data, and they are separate on purpose so that one
leak does not defeat both:

| Variable | Protects | Rotating it |
|---|---|---|
| `PII_ENCRYPTION_KEY` | National ID, tax ID, bank account ciphertext | Can run for days under live traffic |
| `PII_INDEX_KEY` | The blind index used to find and de-duplicate national IDs | **Needs a maintenance window.** See §8.5 |

Run this when a key may have been exposed — a leaked `.env`, a departing
administrator, a compromised host — and on a schedule if your compliance
programme sets one. There is no automatic expiry.

> **Read §8.6 before starting.** The step that makes this reversible is the
> backup taken while the OLD key is still configured, and it cannot be taken
> afterwards.

### 8.1 How the key ring works

`PII_ENCRYPTION_KEY` is the only key that **encrypts**.
`PII_ENCRYPTION_KEYS_OLD` is a comma-separated list that may only **decrypt**.
Reading tries the primary first, then each old key in turn.

Trying keys in turn is safe because the cipher is AES-256-GCM, which
authenticates: the wrong key fails its tag rather than returning plausible
rubbish. The decision is made by the cipher, not guessed by the application.

The ciphertext carries **no key identifier** — only a format version (`v1.`).
That is why rotation works by trial rather than by lookup, and why the rotation
job is worth finishing promptly: every stale row costs one failed tag check on
every read.

### 8.2 The procedure

**Step 1 — generate the new key. Do not deploy it yet.**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Step 2 — record the fingerprint of what is currently readable.**

```bash
node --experimental-transform-types apps/worker/src/verify-pii-fingerprint.ts
```

It prints a digest over every decrypted value — never the values themselves.
**Write the digest down.** It is how you prove at the end that the rotation
preserved meaning rather than merely changing ciphertext. A rotation that
replaced every national ID with rubbish would also change the ciphertext; only
this digest distinguishes the two.

**Step 3 — back up, with the old key still in place.** Follow §6. This backup is
the only way back if step 5 goes wrong.

**Step 4 — deploy with both keys.** The new one primary, the old one demoted:

```bash
PII_ENCRYPTION_KEY="<new>"
PII_ENCRYPTION_KEYS_OLD="<old>"
```

Nothing is rewritten yet. Existing rows still read through the old key; new
writes use the new one. **Verify the application before continuing** — open an
employee with the unmask permission and confirm the national ID is right.

**Step 5 — convert the stored rows.**

```bash
pnpm --filter @hrms/worker pii:rotate -- --dry-run   # count first, change nothing
pnpm --filter @hrms/worker pii:rotate
```

Safe to interrupt and safe to repeat: each row is asked whether the current key
can read it, so a second run skips everything already converted. There is no
progress state to go stale.

Expect `unreadable: 0` and `failed: 0`. **Anything else means stop** — see §8.4.

**Step 6 — confirm the meaning survived.**

```bash
node --experimental-transform-types apps/worker/src/verify-pii-fingerprint.ts
```

The digest must be **identical to step 2**. If it differs, do not proceed to
step 7 — the old key is still your way back.

**Step 7 — withdraw the old key.** Remove `PII_ENCRYPTION_KEYS_OLD` and deploy.

Do not skip this and do not leave it "just in case". A fallback with no end date
is how a system keeps a decade-old key alive in production, and nobody discovers
it until that key is the one that leaks. After this deploy, any row that was
missed fails loudly — which is the point, because that failure is the only
evidence the conversion was incomplete.

### 8.3 Rehearsal record

Rehearsed on the development database, 31 August 2026, 7 employees / 19
encrypted values across 5 tenants:

| Step | Result |
|---|---|
| Rotate forward, old key on the ring | `rotated: 7, columns: 19, unreadable: 0, failed: 0` |
| Fingerprint under the new key alone | **identical** to before the rotation |
| Fingerprint under the old key alone | `values: 0, unreadable: 19` — the data really moved |
| Run the job a second time | `rotated: 0` — idempotent |
| Rotate the index key as well | `indexes: 7, columns: 0` |
| Rotate both keys back | `columns: 19, indexes: 7`, fingerprint identical again |

Not yet rehearsed at production volume, and not yet rehearsed as a live
deployment — only as a job against a database.

### 8.4 When the job reports `unreadable`

The job exits non-zero and names the affected row ids in the log. It means one
of:

- `PII_ENCRYPTION_KEYS_OLD` is missing a key that some rows were written with.
  Find it and add it — every historical key must be on the ring, not just the
  most recent one.
- The rows came from a different database, e.g. a partial restore.

**Do not proceed to step 7 while any row is unreadable.** After step 7 those
values are gone permanently: the ciphertext remains and nothing can open it.

### 8.5 Rotating `PII_INDEX_KEY` — different rules

The index key is what makes "is this national ID already registered?"
answerable. Rotating it needs more care than the encryption key for one specific
reason:

`UNIQUE (tenant_id, national_id_index)` compares **stored** values, and the same
national ID indexed under two different keys produces two different stored
values that never collide. So between rotating the key and finishing the
re-index, **the database will accept two employees with the same national ID**,
and the constraint that exists to prevent exactly that cannot see it.

The application paths do check every candidate index — `findByNationalId` and
the Excel importer's duplicate scan both consult the whole ring — so the ordinary
routes are covered. Anything writing employees outside them is not.

**Therefore:** rotate the index key in a maintenance window with employee
creation and import paused, and run the job to completion before resuming. The
encryption key has no such requirement; do not conflate the two because the
procedure looks similar.

Both keys can be rotated in one pass — set all four variables and run the job
once — which is what you want after a suspected `.env` leak, where you cannot
say which key was exposed.

### 8.6 What this procedure does not cover

- **The keys are not versioned in the ciphertext.** Which key wrote a row cannot
  be read off the row; it is established by trial.
- **No key management service.** Keys live in the environment. Moving them to a
  KMS would change §8.2 entirely.
- **Photo and document files are not encrypted at rest by these keys** — object
  storage handles them, and rotating there is a separate procedure that does not
  exist yet.
- **Not rehearsed at production volume.** The job batches 200 employees per
  transaction, so the lock window is bounded, but total runtime at scale has not
  been measured.

---

## 9. Repairing punch working dates (run once, before the first release)

`punch_logs.work_date` decides which day a punch belongs to. Rows written before
the timezone fix carry the wrong one: the original code used `getUTCHours()`, so
for WIB every punch between 06:00 and 10:59 local landed on **yesterday**, which
is most people's arrival window.

The stored effect is a day holding a clock-out with no clock-in — counted ABSENT
— while the previous day holds two clock-ins. Nothing raises an error; a wrong
date is as valid as a right one, and every figure derived from it is wrong
quietly.

New punches have been correct since the fix. **Old rows are never revisited**,
so they stay wrong until this job runs.

```bash
pnpm --filter @hrms/worker workdate:backfill -- --dry-run
pnpm --filter @hrms/worker workdate:backfill
```

Each punch is passed through the current `resolveWorkDate` with **its tenant's**
timezone and rewritten only where the answer differs. It is therefore idempotent
and safe to repeat — unlike the tempting shortcut of "add a day to punches
before 04:00 UTC", which assumes UTC+7 for every tenant and corrupts correct data
on a second run.

Days the punch left and days it arrived at are both recomputed through the same
function a manual correction uses, so the recap follows the punch.

### 9.1 `daysLocked` is the number that needs a person

A day inside a **closed** attendance period is not recomputed. Closed means
payroll has already used those figures.

- The punch **is** corrected.
- The recap **is not**.

So a non-zero `daysLocked` means the stored recap now disagrees with its own
punches for that many days, and somebody has to decide what to do: reopen the
period and recompute, issue a correction in the next payroll run, or accept the
discrepancy and record why. The job will not choose — silently rewriting figures
that have been paid, or silently leaving a contradiction nobody knows about, are
both worse than reporting it.

Measured on the development database: 32 punches scanned, **3 corrected**, 4 days
affected, of which **2 were locked**. Two of four, on the first real run — expect
this to be common rather than exceptional.

---

## What is not in this runbook

Stated plainly so nobody goes looking for it when they need it:

- **Billing incidents** — the module does not exist.
- **Payment gateway failures** — not integrated.
- **Off-host backup replication** — see the limitation in §7.
- **Rotating the object-storage credentials** — see the limit in §8.6.
