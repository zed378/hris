# 08 — Interaction Design

How the interface responds: to clicks, to waiting, to failure, to concurrency, and to the network disappearing. Rules here are cross-cutting; screen-specific behaviour is in `04-USER-FLOWS.md`.

---

## 1. Feedback Within 100 ms

Every action gives visible feedback immediately, before the server answers.

| Action | Immediate feedback | Current |
|---|---|---|
| Submit a form | Button disabled and relabelled ("Menyimpan…", "Mengirim…") | Disabled everywhere (63 `disabled={…}`); relabelled on most forms (34 progress labels) |
| Punch | Buttons disabled; "sending" state | Yes |
| Upload a file | Progress text; the file name shown | Yes on import and documents |
| Approve / reject | The row's buttons disabled | Yes |

**Never** show success before the server confirms it — except the offline punch, which shows a *different* state ("saved on this device, not yet sent"), not success.

## 2. No Optimistic Updates for Consequential Data

Leave approvals, punches, payroll runs, role changes, and imports update the screen **after** the server confirms. An optimistic approval that the server then refuses with `409` has told the approver something false. Lists refetch after a mutation rather than patching local state.

## 3. Concurrency Is Expected, and Explained

Two HR users act on the same record. The server settles it (row locks, unique indexes); the interface explains it.

| Server says | The interface says |
|---|---|
| `409 CONFLICT` on a leave decision | "Sudah diputuskan sebelumnya" — then refetch the list |
| `409 CONFLICT` on a payroll run for a period | A run for that period already exists — link to it |
| `200 { duplicate: true }` on a punch | Treated as success; the user is not told about the duplicate |

## 4. Sessions Refresh Silently

- A `401 TOKEN_EXPIRED` or `TOKEN_STALE` triggers **one** refresh and one retry inside `api()`. The user notices nothing.
- If the refresh fails, the session ends and the user returns to `/login`.
- A permission change made by an administrator takes effect on the user's **next request** (access version), not at next login. The menu updates on the next bootstrap.

## 5. Destructive Actions Confirm, Reversible Ones Don't

| Action | Confirmation |
|---|---|
| Archive a document ("Berkasnya akan dihapus permanen") | `window.confirm` |
| Cancel a leave request | `window.confirm` |
| Discard an import | Should confirm — the staged rows and error report are lost |
| Close a payroll run | Must confirm — a closed period cannot be edited; a correction is a new run |
| Reject a punch or leave | Requires a reason (the reason is the confirmation) |
| Save a form, approve | No confirmation |

A confirmation names the object and the consequence. "Are you sure?" alone is not a confirmation.

## 6. Real-Time

| Surface | Mechanism | Degradation |
|---|---|---|
| Live dashboard `/attendance/live` | Server-sent stream per tenant (fetch-based, so the bearer header can be sent) | After the stream fails or the 32-streams-per-process cap is hit: 20-second polling, **stated on screen** |
| Everything else | Fetch on load and after mutation | — |

No other screen auto-refreshes. A review queue that reshuffles while HR reads it is worse than a stale one.

## 7. Offline

Offline behaviour is deliberately narrow (P16): **the only offline write is a punch.**

| Surface | Offline behaviour |
|---|---|
| `/attendance/punch` | Queue punches in IndexedDB; banner; queued count; flush on reconnect or app open |
| App shell (static assets) | Served from the service worker's shell cache |
| Every API read | **Not cached.** Shows the page's error state |
| Payslips, dashboards, employee data | Never cached on the device (`../PLAN/11-PWA-Frontend.md` §5.4) |

A page that fails offline should say "Tidak ada koneksi" rather than a generic error — **not yet distinguished** on pages other than punch.

## 8. Notifications

| Channel | Used for | Limits |
|---|---|---|
| Web Push | Leave decisions — title and one line, no reason or comment, because it shows on a lock screen (`apps/worker/src/leave-notify.ts`) | iOS only when installed to the home screen, and unreliable (R52) |
| Email | Invitations, password reset, contract and document expiry reminders. Sent through Resend when `RESEND_API_KEY` is set; printed to the log otherwise. In Indonesian (ADR-034) | Not used for leave decisions |
| In-app | Dashboard cards (pending approvals, flagged ratio) | Seen only when the dashboard is opened |
| WhatsApp | — | Not built |

An important notification never relies on push alone: a leave decision a push fails to deliver is still on `/leave/me` and the home dashboard.

## 9. Keyboard

- Every action is reachable by `Tab` and operable by `Enter` / `Space` — native buttons and links make this free; do not build clickable `div`s.
- Forms submit on `Enter`.
- AG Grid's own keyboard model applies inside the grid.
- **Focus visibility is not consistently styled** — `10-ACCESSIBILITY.md`.

## 10. Time and Dates

- Working dates (which day a punch belongs to) are computed on the server in the **tenant's** time zone. The home dashboard renders the server's `workDate` as a date without re-interpreting it.
- Times of day (`punchedAt`) are rendered with `toLocaleTimeString('id-ID')` in the **device's** time zone. For an employee in the tenant's own zone they agree; for HR viewing a branch in another zone (WIB head office, WIT site) they do not. **Rule for new screens:** HR-facing times of other people's punches render in the tenant's (or site's) time zone, labelled (`08.02 WIT`).
