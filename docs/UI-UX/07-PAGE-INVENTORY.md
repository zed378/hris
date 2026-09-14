# 07 — Page Inventory

Every page that exists, who it is for, what guards it, and what it calls. Generated from `apps/web/src/app/**/page.tsx` on 2026-09-13 — 32 pages, 9,762 lines.

A page listed here without a menu entry is reached another way (`03-INFORMATION-ARCHITECTURE.md` §5). A menu entry without a page fails `apps/web/test/menu-coverage.test.ts`.

"Product" is `desk` or `pocket` (`00-DESIGN-DIRECTION.md`).

---

## Public

| Path | Product | Lines | API | Notes |
|---|---|---|---|---|
| `/login` | both | 140 | `POST /api/auth/login` (via session) | Kode perusahaan, Email, Kata sandi; error in `role="alert"` |
| `/register` | desk | 282 | `POST /api/tenants/register` | Creates tenant and owner; rate-limited 5/hour |
| `/reset-password` | both | 49 | via `TokenPasswordForm` | — |
| `/accept-invitation` | both | 55 | via `TokenPasswordForm` | — |

## Tenant — Home and Modules

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/` | both | 398 | `core.dashboard.view.own` | `/api/dashboard`, `/api/dashboard/trends` |
| `/modules/[code]` | desk | 80 | — | — (locked-module explanation; **not linked from anywhere**) |

## Employees

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/employees` | desk | 260 | `employee.employee.read.all` | `/api/employees` |
| `/employees/grid` | desk | 305 | `employee.employee.read.all` | `/api/employees`, `/api/employees/bulk` |
| `/employees/import` | desk | 374 | `employee.import.execute` | `/api/employees/import`, `/api/employees/import/[id]…` |
| `/employees/documents` | desk | 330 | `employee.document.read` | `/api/employees`, `/api/employees/[id]/documents`, `/api/documents/[docId]` |
| `/employees/contracts` | desk | 147 | `employee.contract.read` | `/api/contracts/expiring` |

## Attendance

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/attendance/punch` | **pocket** | 519 | `attendance.punch.create.own` | `/api/attendance/consent`, `/api/attendance/photo`, `/api/attendance/punch` |
| `/attendance/me` | **pocket** | 174 | `attendance.record.read.own` | `/api/attendance/me` |
| `/attendance/consent` | **pocket** | 229 | `attendance.punch.create.own` | `/api/attendance/consent` |
| `/attendance/live` | desk | 289 | `attendance.record.read.all` | `/api/attendance/live` (stream, 20 s polling fallback), `/api/attendance/records`, `/api/employees` |
| `/attendance/records` | desk | 588 | `attendance.record.read.all` | `/api/attendance/records`, `/api/attendance/manual-punch`, `/api/employees` |
| `/attendance/device-import` | desk | 253 | `attendance.record.correct` | `/api/attendance/device-import` |
| `/attendance/review` | desk | 195 | `attendance.review.handle` | `/api/attendance/review` |
| `/attendance/shifts` | desk | **765** | `attendance.shift.manage` | `/api/attendance/shifts`, `/schedules`, `/holidays`, `/policy`, `/api/employees` |
| `/attendance/sites` | desk | 368 | `attendance.shift.manage` | `/api/attendance/work-sites` |

## Leave

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/leave/me` | **pocket** | 551 | `leave.request.read.own` | `/api/leave/types`, `/balances`, `/requests`, `/approvers`, `/attachments` |
| `/leave/approvals` | both | 273 | `leave.request.approve` | `/api/leave/requests`, `/requests/[id]/decision`, `/balances`, `/api/employees` |
| `/leave/calendar` | desk | 281 | `leave.request.read.team` | `/api/leave/requests`, `/api/employees` |
| `/leave/policies` | desk | 375 | `leave.policy.manage` | `/api/leave/types`, `/balances`, `/api/employees` |

## Payroll

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/payroll/me` | **pocket** | 210 | `payroll.payslip.read.own` | `/api/payroll/payslips` |
| `/payroll/runs` | desk | 441 | `payroll.run.execute` | `/api/payroll/runs`, `/runs/[id]` |
| `/payroll/structures` | desk | 279 | `payroll.salary.read` | `/api/payroll/salary`, `/components`, `/api/employees` |
| `/payroll/components` | desk | 375 | `payroll.component.manage` | `/api/payroll/components` |

## Settings

| Path | Product | Lines | Permission | API |
|---|---|---|---|---|
| `/settings/subscription` | desk | 270 | `core.settings.manage` | `/api/subscription` |
| `/settings/users` | desk | 419 | `iam.user.read` | `/api/users`, `/users/[id]…`, `/users/from-employees`, `/api/roles` |
| `/settings/roles` | desk | 230 | `iam.role.read` | `/api/roles`, `/roles/[id]/permissions` |
| `/settings/audit` | desk | 197 | `iam.audit.read` | `/api/audit` |

## Control Plane

| Path | Product | Lines | Guard | API |
|---|---|---|---|---|
| `/admin` | desk | 459 | Superuser session (`hrms-admin`), TOTP | `/admin/api/auth/login`, `/overview`, `/tenants`, `/tenants/detail`, `/tenants/status` |

## Not a Page

| File | Purpose |
|---|---|
| `app/layout.tsx` | Root layout: `lang="id"`, theme colour, `SessionProvider`, `ServiceWorker` |
| `app/not-found.tsx` | 404 with a link home |

---

## Observations

- **Five pocket pages** (`punch`, `attendance/me`, `consent`, `leave/me`, `payroll/me`) and one shared (`leave/approvals`). Those six are the ones a mobile navigation must reach.
- **The largest pages** — `shifts` (765), `records` (588), `leave/me` (551), `punch` (519) — each combine several tasks. `shifts` in particular holds shifts, schedules, holidays, and the attendance policy on one page; the policy is arguably its own page.
- **Pages fetch their data client-side through `api()`**; no page imports server code (`apps/web/test/frontend-boundary.test.ts`). Every page therefore needs its own loading, empty, and error states (`11`).
- **`/employees` and `/employees/grid` show the same data** two ways. Keep both: the list for looking, the grid for editing.
