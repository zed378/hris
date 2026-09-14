# 02 — User Journeys

The end-to-end paths that decide whether this product is adopted. Each journey states its stages, what the user feels at each, the screens involved, and where it breaks today. Personas are from `01-USER-PERSONAS.md`; the step-by-step flows are in `04-USER-FLOWS.md`.

---

## Journey 1: From Spreadsheet to First Month Closed (Ratna and Dewi)

This is the journey Gate A in `../PLAN/12-Small-Team-Execution-Plan.md` §6 measures: **three pilots importing ≥ 100 employees unaided in under 30 minutes**.

| Stage | User | Screen | Feels | Breaks today |
|---|---|---|---|---|
| 1. Register | Ratna | `/register` | Hopeful, impatient | — |
| 2. Land on home | Ratna | `/` | "Now what?" | No first-run guidance; the empty dashboard does not say what to do first |
| 3. Invite HR | Ratna | `/settings/users` | Delegating | — |
| 4. Accept invitation | Dewi | `/accept-invitation` | — | — |
| 5. Download template | Dewi | `/employees/import` | Sceptical | — |
| 6. Upload her own file | Dewi | `/employees/import` | Anxious about her data | — |
| 7. Fix row errors and re-upload | Dewi | `/employees/import` | Frustrated if errors are vague; relieved if they name the row | — |
| 8. Commit | Dewi | `/employees/import` | Relief | — |
| 9. Check in the grid | Dewi | `/employees/grid` | Recognition — "it looks like my sheet" | — |
| 10. Set up sites and shifts | Dewi | `/attendance/sites`, `/attendance/shifts` | Effortful | Network ranges for office verification can be entered, but the check is spoofable (`../SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md` §4) |
| 11. Create employee accounts | Dewi | `/settings/users` | — | — |
| 12. First month of punches | Everyone | Journey 2 | — | — |
| 13. Review flagged punches | Dewi | `/attendance/review` | Judging | — |
| 14. Close the month's recap | Dewi | `/attendance/records` | Done | — |

**Moment of truth:** stage 7. If the error report does not let her fix her own file, she returns to Excel.

## Journey 2: A Morning Clock-In (Sari and Joko)

| Stage | User | Screen | Feels | Breaks today |
|---|---|---|---|---|
| 1. Open the app from the home screen | Sari | PWA shortcut → `/attendance/punch` | Rushed | — |
| 2. First time only: why location and photo are needed | Sari | `/attendance/punch`, `/attendance/consent` | Suspicious, then reassured | — |
| 3. Browser permission prompt | Sari | Browser | — | — |
| 4. Take selfie | Sari | Camera via file input | Self-conscious | — |
| 5. Tap to punch | Sari | `/attendance/punch` | — | — |
| 6. See the result: accepted, or flagged with a reason | Sari | `/attendance/punch` | Relief, or worry | — |
| 1′. No signal | Joko | `/attendance/punch` | Anxious | — |
| 2′. Punch queued on the device, clearly marked unsent | Joko | `/attendance/punch` | "Did it work?" | A photo cannot be taken offline (by design, `../PLAN/11` §6) |
| 3′. Signal returns; queue flushes once | Joko | automatic | Unaware | iOS may evict the queue after 7 days (R48) |
| 4′. Checks later | Joko | `/attendance/me` | Reassured | **On a phone, `/attendance/me` is reachable only by the PWA shortcut or a typed URL** — no mobile navigation, and the home dashboard does not link to it |

**Moment of truth:** stage 6. "Did it count?" must be answered without doubt.

## Journey 3: Requesting and Approving Leave (Sari, Hendra)

| Stage | User | Screen | Feels | Breaks today |
|---|---|---|---|---|
| 1. Check balance | Sari | `/leave/me` | Planning | On a phone, reachable only through a home dashboard card; no way back home afterwards except the browser |
| 2. Submit request with attachment | Sari | `/leave/me` | — | — |
| 3. Approver is notified | Hendra | Web Push / email | — | iOS push unreliable (R52); WhatsApp not built |
| 4. Open approvals | Hendra | `/leave/approvals` | Wants to be done in a minute | On a phone: reachable through the home dashboard card when requests are pending; no sidebar |
| 5. Approve or reject with a note | Hendra | `/leave/approvals` | — | — |
| 6. Requester sees the decision and new balance | Sari | `/leave/me` | — | — |

**Moment of truth:** stage 4 on a phone.

## Journey 4: "Why Was My Pay Cut?" (Sari, Dewi)

| Stage | User | Screen | Breaks today |
|---|---|---|---|
| 1. Opens payslip | Sari | `/payroll/me` | Statutory components not built (Gate C) — payslips are framework-level only |
| 2. Asks HR | Sari | Outside the system | — |
| 3. Finds the attendance days behind the deduction | Dewi | `/attendance/records` | — |
| 4. Shows the calculation trace | Dewi | `/payroll/runs` | `calculation_trace` exists for built components |

**Moment of truth:** stage 4 — evidence instead of argument (`../PLAN/12` §6 Phase 5).

## Journey 5: Upgrading to a Module (Ratna)

| Stage | Screen | Breaks today |
|---|---|---|
| 1. Reaches an unsubscribed module's page from an old bookmark | the module page | Generic error line; the locked-module page `/modules/[code]` exists but nothing routes there |
| 2. Opens subscription settings | `/settings/subscription` | — |
| 3. Enables the module | `/settings/subscription` | **Payment not built** — no self-serve purchase (Gate B/Phase 6) |
| 4. Menu updates without logging in again | App shell | — |

## Journey 6: Leaving a Shared Phone (Joko)

| Stage | Screen | Breaks today |
|---|---|---|
| 1. Logs out | App shell "Keluar" | On a phone the header button is visible; fine |
| 2. Next person opens the app | `/login` | — |
| 3. Nothing of Joko's is readable | — | Tested in `service-worker.test.ts`; not verified on a physical device |
