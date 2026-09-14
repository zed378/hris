# Phase 3 — Attendance and PWA

**Goal** (`docs/PLAN/12` §6): daily attendance that people will pay for — punching from a phone with scored evidence, an offline queue, and an HR review queue.

**State**: delivered, with the device and Lighthouse items unverified (`docs/PLAN/13` §5 "Phase 3 DoD items not yet verified"). **Office-network verification shipped with a bypass** (`P3-12`). **Gate B has not been tested.**

**Phase 3 DoD** (`docs/PLAN/12` §6):

- [x] A punch outside the geofence is still recorded and flagged
- [~] A denied permission is handled per tenant policy — yes, but `FALLBACK_ONLY` is bypassable through `X-Forwarded-For` (`P3-12`)
- [x] A flagged punch enters the review queue
- [x] EXIF stripped; photos deleted after retention, attendance rows intact
- [x] Offline punches replay with no duplicate even if flushed twice
- [x] Sensitive endpoints never enter Cache Storage — `service-worker.test.ts`
- [~] Cache and push subscription wiped on logout — built; **not verified on a shared physical device** (`P3-16`)
- [x] Tokens never in Cache Storage or IndexedDB
- [ ] Lighthouse PWA 100, Performance ≥ 90 mobile — `P3-14`
- [ ] Chromium, WebKit, and ≥ 2 real devices — `P3-15`

> **Gate B** — at least one tenant pays for Employees + Attendance before Phase 4 starts. Not tested; Phase 4 was built anyway (`DV-01`).

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P3-01 | Shifts, schedule patterns (including non-Monday–Friday), national holidays with tenant overrides | `/attendance/shifts`; `leave.test.ts` schedule cases | DONE (retro) |
| P3-02 | Punch sources: web/PWA, manual HR entry, generic attendance machine CSV/Excel import | `manual-punch`, `device-import` routes; `device-format.test.ts` | DONE (retro) |
| P3-03 | PWA: manifest, shortcuts, hand-written service worker, per-tenant/user cache rules, wipe on logout | `apps/web/public/sw.js`; `service-worker.test.ts` | DONE (retro) |
| P3-04 | Offline punch queue in IndexedDB with `dedupeKey`, persistence request, permanent-error drop, other users' punches left alone | `apps/web/src/lib/offline-queue.ts`; `offline-queue.test.ts` | DONE (retro) |
| P3-05 | Work sites with geofence; coordinates and accuracy; selfie compressed on device; EXIF stripped server-side; retention job | `photo.test.ts`; `apps/worker/src/photo-retention.ts` | DONE (retro) |
| P3-06 | Layered trust scoring; HR review queue with reasons | `trust.test.ts`; `/attendance/review` | DONE (retro) |
| P3-07 | Consent screen; withdrawal honoured and not penalised | `/attendance/consent`; `consent.ts` | DONE (retro) |
| P3-08 | Daily calculation, audited manual correction, period recap, period close locking days | `packages/core/src/attendance/daily.ts` | DONE (retro) |
| P3-09 | Live dashboard: SSE over per-tenant `LISTEN`/`NOTIFY`, 32 streams per process, 20-second polling fallback, no coordinates | `live-events.ts`; proxy test in `ops/proxy-test` | DONE (retro) |
| P3-10 | Tenant and site time zones; working date resolved in local time | `workdate.test.ts`; `docs/PLAN/13` §2.1 | DONE (retro) |
| P3-11 | Office network ranges per work site; `FALLBACK_ONLY` enforced; `OFFICE_IP_VERIFIED` removes the browser penalty | `office-network.ts`, `cidr.test.ts`; migration `20260901090000` | DONE (retro) — **with defect `P3-12`** |
| P3-19 | Partial index for the review queue, built concurrently | `migrations-online/0001_review_queue_index.sql` | DONE (retro) |

---

## Open

### P3-12 — Take the client address from the trusted proxy

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0 — open vulnerability, high likelihood** |
| **Depends on** | — |
| **Plan refs** | `docs/SECURITY/02` §4, `docs/PLAN/15` §4 and §9, `docs/PLAN/23` worked example, `ops/proxy/proxy-common.inc`, risk F1 |
| **Spec required** | Yes — authentication (rate limits) and attendance evidence |
| **Surface** | web, auth, ops |
| **Size** | M |

**Goal** — no client-supplied header can change the address used for per-address rate limits, office-network verification, or audit rows.

**Steps**
1. Spec at `MEMORY/specs/P3-12-trusted-client-address.md` (a draft exists).
2. One helper, e.g. `clientAddress(req, { trustedProxies })`, in a shared package, replacing the three call sites: `apps/web/src/lib/define-route.ts`, `define-admin-route.ts`, `apps/auth/src/http.ts`.
3. Trust model — the draft spec recommends reading **only** `X-Real-IP` (which the reference nginx already sets from `$remote_addr`) and only when `TRUST_PROXY=true`; otherwise the address is unknown. The alternative is a trusted-hop count over `X-Forwarded-For`. Note the default Compose topology publishes `web` with no proxy, so nothing there is trustworthy until a proxy is placed in front.
4. Fail safe: a malformed or missing header yields "unknown" for office verification (no match) and a shared bucket for rate limiting — never the client's claim.
5. Add `TRUST_PROXY` to `.env.example` and to `web` and `auth` in the `split` profile; report `clientAddress` in `/api/ready`.
6. Re-examine punches recorded with `OFFICE_IP_VERIFIED` since migration `20260901090000`: they cannot be re-verified. Decide in the spec whether to return them to review (`docs/SECURITY/04` Playbook 6) — on real tenant data this is a per-tenant decision, not a silent re-score.

**Definition of Done**
- A gateway-level test through the real `defineRoute` handler: `X-Forwarded-For: <office>, <real>` with one trusted hop → `recordPunch` sees `<real>`; the office match fails; `FALLBACK_ONLY` refuses a punch without evidence.
- A rate-limit test rotating the first header entry on every request → the per-address limit still trips.
- The same two tests for `apps/auth` (its login route) and the admin plane.
- Both tests shown to fail against the current code before the fix (ADR-020).
- `docs/SECURITY/02` §4 status, `docs/PLAN/15` §9, `docs/PLAN/17` §9, `docs/PLAN/22` F1, `docs/PLAN/23` worked example, `docs/SECURITY/03` D-10 updated.

**Abuse cases to test** — `SECURITY/02` §4(a) office-network spoofing, §4(b) rate-limit evasion, §4(c) audit address forgery; §2(a) credential stuffing with rotated headers.

### P3-13 — Run the `work_date` backfill before the first release

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — |
| **Plan refs** | `ops/RUNBOOK.md` §9, `docs/PLAN/13` §5 Technical debt |
| **Spec required** | No — the job exists |
| **Surface** | ops |
| **Size** | S |

**Goal** — every punch on the target database filed under its tenant's local working date.

**Definition of Done** — `pnpm --filter @hrms/worker workdate:backfill` run on the target database; `daysLocked` reviewed by a person (`RUNBOOK` §9.1); the output in `MEMORY/records/`.

### P3-14 — Lighthouse on the pocket pages

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — (a production build locally is enough to start) |
| **Plan refs** | `docs/PLAN/12` Phase 3 DoD, `docs/UI-UX/09` §5, `docs/UI-UX/14` R3 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Goal** — Lighthouse mobile scores for `/attendance/punch`, `/attendance/me`, `/leave/me`, `/payroll/me`, and `/login` recorded; failures become tasks.

**Definition of Done** — Performance, PWA, and Accessibility scores per page with the build commit and throttling profile, in `MEMORY/records/`; `docs/PLAN/18` §3 updated.

### P3-15 — Verify on Chromium, WebKit, and two real devices

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | Devices; `P0-14` covers the 24-hour part |
| **Plan refs** | `docs/PLAN/12` Phase 3 DoD, `docs/UI-UX/09` §6 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Definition of Done** — the punch, offline, and consent flows (`docs/UI-UX/04` Flows 4, 5) pass on each; results recorded.

### P3-16 — Verify logout wipe on a shared physical device

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | A physical device |
| **Plan refs** | `docs/SECURITY/02` §16, `docs/PLAN/11` §5 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — two accounts on one phone: after the first logs out, Cache Storage holds only the shell, IndexedDB holds only the first user's unsent punches (not sent under the second), no push subscription remains, and no page shows the first user's data.

### P3-17 — Calibrate the 12% flagged-ratio threshold

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | Pilot data (`P2-09`) |
| **Plan refs** | `docs/PLAN/12` §11, `docs/PLAN/13` §5 Technical debt |
| **Spec required** | No |
| **Surface** | backend |
| **Size** | S |

**Goal** — a threshold based on observed pilot flag rates, replacing the planned 12%, recorded by ADR.

### P3-18 — Test `checkOfficeNetwork` against real PostgreSQL

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — (independent of `P3-12`) |
| **Plan refs** | `docs/PLAN/23` worked example §17, `docs/PLAN/16` §1 |
| **Spec required** | No — coverage only |
| **Surface** | backend |
| **Size** | S |

**Goal** — integration coverage for the containment query, which today is tested only through its pure helpers.

**Definition of Done** — a real-PostgreSQL test covering: IPv4 inside and outside a `/24`; IPv6 inside a `/64`; IPv4-mapped IPv6; an inactive work site ignored; a tenant with no ranges → `configured: false`; another tenant's ranges invisible; an unparseable address → no match and no exception. Seen to fail by breaking the `<<=` operator.
