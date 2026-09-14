# 01 — User Personas

Six people who use this product, derived from the system roles seeded in `packages/db/prisma/seed.ts` and the market described in `../PLAN/00-Reference-System-Analysis.md`. Names are illustrative. Feature specs refer to personas by name (`../PLAN/23-FEATURE-SPECIFICATION-TEMPLATE.md` §2).

A role is not a persona: a tenant can create custom roles, and one person can hold several. Personas describe **what someone is trying to get done**; roles describe what they are allowed to do.

---

## Bu Ratna — Company Owner

| | |
|---|---|
| Role | `TENANT_OWNER` (every permission) |
| Company | A 60-person distributor in Surabaya; she registered the account herself during the trial |
| Device | Laptop in the office, phone everywhere else |
| Goals | Stop paying someone to maintain the attendance spreadsheet; know who was absent without asking; see what payroll will cost before it is paid |
| Frustrations | Software that needs a consultant to set up; being asked to decide things she does not understand ("RLS", "grant") |
| Uses | Registration, subscription and modules, users, the home dashboard |
| Design implications | Setup must be completable alone. Trial days left are always visible. Settings use business words, not system words |

## Mbak Dewi — HR Administrator

| | |
|---|---|
| Role | `HR_ADMIN` |
| Background | Has run HR from Excel for six years; very fast with spreadsheets; wary of anything that makes her slower |
| Device | A 14-inch laptop, all day |
| Goals | Import 60 employees from her existing file in one sitting; close attendance for the month without chasing managers; answer "why was my pay cut?" with evidence |
| Frustrations | One-form-per-record data entry; errors that do not say which row; a system that hides data she is responsible for |
| Uses | Employees, grid, import, documents, contracts, records, review queue, device import, shifts and sites, leave policies, payroll |
| Design implications | High density is welcome. Every table filters and exports. Import errors point to the row and column. Bulk actions exist where she would otherwise click 60 times |

## Pak Hendra — Department Head

| | |
|---|---|
| Role | `DEPT_HEAD` (team scope) |
| Device | Phone first, laptop sometimes |
| Goals | Approve leave in a minute from wherever he is; see who in his team is in today |
| Frustrations | Approvals he does not hear about; seeing data about people outside his team he did not ask for |
| Uses | Leave approvals, leave calendar, home dashboard (team) |
| Design implications | Approval must work on a phone — which today depends on reaching the page without navigation (`09`) |

## Mas Budi — Line Manager

| | |
|---|---|
| Role | `LINE_MANAGER` (team scope; same permissions as `DEPT_HEAD` in the seed) |
| Context | Supervises a shift of 15 warehouse staff |
| Goals | Know within minutes who has not clocked in for the morning shift |
| Uses | Leave approvals, leave calendar, dashboard |
| Design implications | "Who is missing" matters more than "who is present" |

## Sari — Office Employee

| | |
|---|---|
| Role | `EMPLOYEE` |
| Device | Mid-range Android, installed the PWA from the home-screen prompt |
| Goals | Clock in without thinking about it; check leave balance; download a payslip |
| Frustrations | Being asked for location every time; not knowing if a punch "went through" |
| Uses | Punch, my attendance, my leave, my payslip, consent |
| Design implications | The punch is one tap after the first-time permission explanation. Status after a punch is unambiguous |

## Joko — Field and Shift Worker

| | |
|---|---|
| Role | `EMPLOYEE` |
| Context | Night shift at a site outside the city; a shared phone in the site office some days; weak or no signal |
| Device | An older Android, limited data, sometimes someone else's |
| Goals | Get credited for the shift he worked |
| Frustrations | Punches failing without signal; being flagged because GPS is poor indoors; the next person on the shared phone seeing his data |
| Uses | Punch (often offline), my attendance |
| Design implications | Offline punch must be reliable and honest about its state. A flag must explain itself. Logout must leave nothing behind. Every screen must work at 360 px and on a slow CPU |

## Secondary: Platform Superuser

The operator of the service (`/admin`), not a customer. Uses the control plane to manage tenant status and plans. Never sees tenant employee data (P11). Designed for correctness over polish; not a persona the product is optimised for.

---

## Persona × Screen Matrix

| Screen | Ratna | Dewi | Hendra | Budi | Sari | Joko |
|---|---|---|---|---|---|---|
| Home dashboard | ● | ● | ● team | ● team | ● own | ○ |
| Employees / grid / import | ○ | ● | | | | |
| Punch | ○ | ○ | ○ | ○ | ● | ● |
| My attendance | | | ○ | ○ | ● | ● |
| Review queue | | ● | | | | |
| Live dashboard | ○ | ● | | | | |
| Leave (mine) | ○ | ○ | ○ | ○ | ● | ○ |
| Leave approvals / calendar | | ● | ● | ● | | |
| Payroll runs / structures | ○ | ● | | | | |
| My payslip | ○ | ○ | ○ | ○ | ● | ● |
| Subscription | ● | | | | | |
| Users / roles / audit | ● | ○ | | | | |

● primary · ○ occasional
