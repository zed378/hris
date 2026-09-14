# 18 — Performance and Capacity

The targets this system is held to, what has actually been measured, the design decisions made for performance, and what has not been measured at all.

The distinction this document insists on: **a number without its conditions is not a measurement.** Every figure below says what it was measured against. Where nothing was measured, it says so.

---

## 1. Targets

Collected from where they were set, not invented here.

| Target | Source |
|---|---|
| p95 API latency **< 500 ms** | `12-Small-Team-Execution-Plan.md` §11 |
| Availability **≥ 99.5%** monthly | `12` §11, `00-Reference-System-Analysis.md` §4 |
| Live dashboard: punch to screen **< 2 s** | `10-Geolocation-Photo-Attendance.md`, `13` §3 |
| Excel import: **5,000 rows** validated and committed in **< 60 s** | `12` spike S2 |
| RLS context: **zero leaks across 100,000** concurrent transactions | `12` spike S3 |
| Payroll: **1,000 employees in < 3 minutes** | `12` Phase 5 DoD |
| PWA: Lighthouse PWA **100**, Performance **≥ 90** on mobile | `12` Phase 3 DoD |
| Migrations holding a lock **> 2 s: zero** | `12` §11 |

## 2. Measured

| Measurement | Result | Conditions |
|---|---|---|
| Live dashboard latency | **305 ms** punch → stream | Development machine, one listener (`13` §3) |
| SSE through a real nginx | **0.07–0.08 s** propagation | Default buffering, buffering forced, and gzip — all three (`ops/proxy-test/README.md`) |
| Concurrent leave approvals | 50 against a 2-day balance → **exactly 1** succeeds, 49 × `409` | Development database (`13` §3) |
| Tenant quota under flood | 700 concurrent requests → **100 refused** with `429` | Development, one process |
| Overload behaviour | **0 × 500**, 372 × `503` with `retry-after` | Same flood |
| Backup and restore at size | 160 MB / 261,000 punches: backup **2 s**, restore **5 s**, row counts identical | `ops/RUNBOOK.md` §6 |
| Readiness recovery | `ready` returns 200 within **40 ms** of PostgreSQL returning | `13` §3 |
| Redis rate-limit cold start | First request after restart correctly counted in Redis | After the fix recorded in `14` §10.3 |
| Payroll run in the worker | 1,003 employees, 21 chunks of 50: **8.5 s**; re-running the same run: 0 new payslips, 13 ms | Payroll **framework** only — components and formulas, no PPh 21 or BPJS (`13` §5) |

## 3. Not Measured

| Target | Status |
|---|---|
| p95 < 500 ms under realistic load | **Never load-tested.** Histogram buckets exist around 500 ms (`19-OBSERVABILITY.md`), but nothing has driven traffic at them |
| Spike S2 — 5,000-row import in < 60 s | Not recorded as run |
| Spike S3 — 100,000 concurrent transactions | Not recorded as run. RLS isolation is proven by tests, not at that concurrency |
| 1,000-employee payroll in < 3 minutes **with statutory components** | The framework run is measured (§2); PPh 21 and BPJS do not exist yet (Gate C), so the number that matters is not |
| Lighthouse scores | Not run |
| Latency cost of the remote authorization call (split topology) | Not measured; the permission cache is the mitigation (`14` §5) |
| Availability | No uptime monitor exists to measure it |

## 4. Design Decisions Made for Performance

| Decision | Why | Where |
|---|---|---|
| The tenant quota is checked **before** a connection is taken | Checking it inside the transaction consumes the connection it exists to protect | `define-route.ts` |
| Per-role `statement_timeout` | A runaway query ends instead of holding a connection indefinitely | Migration |
| Aggregation in SQL, not in application loops | `date_trunc`/`FILTER` in one pass; three queries for a six-month trend regardless of range | `packages/core/src/dashboard/trends.ts` |
| SSE over `LISTEN`/`NOTIFY`, one channel per tenant; 32 streams per process, then 20-second polling | No WebSocket fan-out infrastructure; the degradation is stated on screen | `live-events.ts`, `13` §2.3 |
| Permission resolution cached, keyed by access version | Six queries per request avoided on a hit; required before authorization crosses a network | `packages/cache/src/access-cache.ts` |
| Partial index for the review queue | The queue reads < 12% of punches; a full index would slow every clock-in | `migrations-online/0001_review_queue_index.sql` |
| Index builds on live tables are concurrent | A write lock on `punch_logs` is every employee unable to clock in | `ops/scripts/run-online-migrations.mjs` |
| Trends fetched after, and separately from, the dashboard summary | The summary is needed to render anything; grouped history is not | `apps/web/src/app/page.tsx` |

## 5. Capacity Assumptions

**None have been stated.** `12` §7 sizes the *team*, not the system. There is no expected number of tenants, concurrent users, punches per minute at 08:00, or payroll runs per month written down anywhere — so there is nothing to size a host against or to design a load test around.

What the architecture assumes implicitly, from `12` §10.3 N2: *"acceptable at 5–50 tenants; reviewed above that."* That is the only stated bound, and it is a review trigger rather than a capacity figure.

Recorded as `TASKS/BACKLOG.md` `OQ-05`.

## 6. The Morning Peak

The load shape that matters for an Indonesian HR product is not average traffic. It is **the whole company clocking in between 07:30 and 08:30 WIB**, from phones on mobile networks, often after a night offline with a queue to flush.

Any load test worth running models that: a burst of punch writes with photo uploads, offline queue replays arriving together when a train reaches a station, and the live dashboard open on HR's screen throughout. A flat request rate would pass and prove nothing about the hour that decides whether attendance works.
