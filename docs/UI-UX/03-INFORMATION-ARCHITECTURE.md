# 03 — Information Architecture

How the product is organised: the navigation tree, what decides who sees what, and the URL scheme.

**The navigation is data, not code.** The sidebar is rendered entirely from `GET /api/me/bootstrap`, which returns only the menu nodes the user may see for modules the tenant subscribes to. No menu list exists in the frontend (`apps/web/src/components/app-shell.tsx`). Menus are seeded in `packages/db/prisma/seed.ts` and resolved by `../PLAN/05-Dynamic-Role-Menu-Access.md`.

---

## 1. Planes

| Plane | Entry | Audience | Navigation |
|---|---|---|---|
| Public | `/login`, `/register`, `/reset-password`, `/accept-invitation` | Anyone | None — single-purpose pages |
| Tenant | `/` and everything under the app shell | Tenant users | Dynamic sidebar |
| Control | `/admin` | Platform superusers | Its own page; separate session (P11) |

## 2. The Tenant Navigation Tree

Labels are the Indonesian labels users see. Each leaf shows the permission that makes it visible; its module must also be subscribed.

```
Beranda                          /                         core.dashboard.view.own
Karyawan                         (group · employee)
├── Daftar Karyawan              /employees                employee.employee.read.all
├── Grid Karyawan                /employees/grid           employee.employee.read.all
├── Impor Excel                  /employees/import         employee.import.execute
├── Dokumen Karyawan             /employees/documents      employee.document.read
└── Kontrak Kerja                /employees/contracts      employee.contract.read
Presensi                         (group · attendance)
├── Absen Sekarang               /attendance/punch         attendance.punch.create.own
├── Presensi Saya                /attendance/me            attendance.record.read.own
├── Persetujuan Data             /attendance/consent       attendance.punch.create.own
├── Dasbor Langsung              /attendance/live          attendance.record.read.all
├── Rekap Kehadiran              /attendance/records       attendance.record.read.all
├── Impor Mesin Absensi          /attendance/device-import attendance.record.correct
├── Antrean Tinjauan             /attendance/review        attendance.review.handle
├── Shift & Jadwal               /attendance/shifts        attendance.shift.manage
└── Lokasi Kerja                 /attendance/sites         attendance.shift.manage
Cuti                             (group · leave)
├── Cuti Saya                    /leave/me                 leave.request.read.own
├── Persetujuan                  /leave/approvals          leave.request.approve
├── Kalender Cuti                /leave/calendar           leave.request.read.team
└── Kebijakan Cuti               /leave/policies           leave.policy.manage
Penggajian                       (group · payroll)
├── Slip Gaji Saya               /payroll/me               payroll.payslip.read.own
├── Proses Gaji                  /payroll/runs             payroll.run.execute
├── Struktur Gaji                /payroll/structures       payroll.salary.read
└── Komponen Gaji                /payroll/components       payroll.component.manage
Pengaturan                       (group · iam)
├── Langganan & Modul            /settings/subscription    core.settings.manage
├── Pengguna                     /settings/users           iam.user.read
├── Peran & Hak Akses            /settings/roles           iam.role.read
└── Jejak Audit                  /settings/audit           iam.audit.read
```

A group with no visible children is removed by the server; the client does not re-check.

## 3. What Each Seeded Role Sees

| Role | Groups visible (all modules subscribed) |
|---|---|
| `TENANT_OWNER` | Everything |
| `HR_ADMIN` | Everything except Kalender Cuti (holds `leave.request.read.all`, not `read.team`). Sees Peran & Hak Akses, but cannot change roles (no `iam.role.manage`) |
| `DEPT_HEAD`, `LINE_MANAGER` | Beranda; Presensi → Absen Sekarang, Presensi Saya, Persetujuan Data; Cuti → Cuti Saya, Persetujuan, Kalender Cuti; Penggajian → Slip Gaji Saya |
| `EMPLOYEE` | Beranda; Presensi → Absen Sekarang, Presensi Saya, Persetujuan Data; Cuti → Cuti Saya; Penggajian → Slip Gaji Saya |

An employee therefore has **eight** destinations. That is the whole pocket product (`00-DESIGN-DIRECTION.md`) — and the set a mobile navigation must expose.

## 4. Structure Rules

1. **Group by module, then by audience within the module**: "mine" pages first (Absen Sekarang, Presensi Saya, Cuti Saya, Slip Gaji Saya), team and administration pages after. A new page follows the same order.
2. **"Mine" pages end in `/me`** (`/attendance/me`, `/leave/me`, `/payroll/me`) — except the punch action, which is a verb.
3. **A module's URLs start with the module's path**: `/employees`, `/attendance`, `/leave`, `/payroll`. Tenant-wide settings live under `/settings`.
4. **Every leaf maps to exactly one page**, guarded by `apps/web/test/menu-coverage.test.ts`.
5. **A menu permission is never weaker than the page's API permission.** A visible menu leading to a `403` is a bug.
6. **Unsubscribed modules are not shown in the menu.** `/modules/[code]`, the locked-module page, explains a module and links to subscription settings — but **nothing links to it today**; a direct visit to an unsubscribed module's page shows that page's generic error.
7. **Icons are seeded** (`home`, `users`, `clock`, `calendar`, `wallet`, `settings`) **but not rendered** by the app shell today. A mobile navigation is the natural place to start using them.

## 5. Entry Points Outside the Sidebar

| Entry | Target | Source |
|---|---|---|
| PWA shortcut "Presensi" | `/attendance/punch` | `public/manifest.webmanifest` |
| PWA shortcut "Presensi Saya" | `/attendance/me` | Same |
| Invitation email | `/accept-invitation?token=…` | Invitation flow |
| Password reset email | `/reset-password?token=…` | Reset flow |
| Web Push notification | The relevant page | `apps/web/src/lib/push.ts` |
| Locked-module page | `/modules/[code]` | Built; not linked from anywhere |

## 6. Known Gaps

- **No mobile navigation** (`09-RESPONSIVE-AND-MOBILE.md`). Below 768 px the home dashboard cards are the only onward links, and nothing links back to home — the tenant name in the header is not a link.
- **Back links are rare**: import links back to the employee list, the locked-module and 404 pages link home. Elsewhere the sidebar is the only wayfinding.
- **No search** across employees from the shell.
- **No "home" for a first-run tenant** — the dashboard is empty until data exists (`02-USER-JOURNEYS.md` Journey 1 stage 2).
