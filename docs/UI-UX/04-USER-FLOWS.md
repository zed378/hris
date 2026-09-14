# 04 — User Flows

Step-by-step flows for the journeys in `02-USER-JOURNEYS.md`, including every branch a real user hits. Each flow names the endpoints involved, so a flow and its API contract can be checked against each other.

---

## Flow 1: Sign In

```
/login
  ├─ Kode perusahaan, Email, Kata sandi
  ├─ POST /api/auth/login
  │    ├─ 200 → access token in memory, refresh cookie set → GET /api/me/bootstrap → /
  │    ├─ 401 INVALID_CREDENTIALS → one generic message; never says which field was wrong
  │    ├─ 423 ACCOUNT_LOCKED → message with the wait time from retry-after
  │    ├─ 403 TENANT_SUSPENDED → "company account inactive"; no retry suggested
  │    └─ 429 RATE_LIMITED → wait time from retry-after
  └─ "Lupa kata sandi" → Flow 2
```

On reload, the session is restored by `POST /api/auth/refresh` using the cookie; the user never sees a login page if the refresh token is valid. A `401 TOKEN_STALE` on any request triggers one silent refresh and retry (`apps/web/src/lib/session.tsx`).

## Flow 2: Reset Password

```
/login → "Lupa kata sandi"
  ├─ POST /api/auth/password/forgot → always 204 → "if the address exists, an email was sent"
  └─ email link → /reset-password?token=…
        ├─ new password (12–128 characters, `passwordSchema`) → POST /api/auth/password/reset → /login
        └─ token expired or used → message + link back to request another
```

## Flow 3: Import Employees From Excel

```
/employees/import
  ├─ download template (GET /api/employees/template)
  ├─ upload .xlsx (≤ 10 MB) → POST /api/employees/import
  │    ├─ rejected file (size, type) → message; nothing staged
  │    └─ staged → preview with per-row status
  │         ├─ all rows valid → "Commit"
  │         └─ some rows invalid → error report naming row and column
  │               ├─ fix in Excel, re-upload → back to staged
  │               └─ discard → staging deleted (employee.import.discarded)
  └─ commit → employees created (employee.import.committed) → link to /employees/grid
```

PII in staging is never stored in plaintext (`../PLAN/17-SECURITY-BASELINE.md` §5).

## Flow 4: Punch (Online)

```
/attendance/punch
  ├─ GET /api/attendance/policy → requireLocation? requirePhoto? onPermissionDenied?
  ├─ consent state read first: without location consent (given on /attendance/consent, where the consequence of refusing is stated before any button), the location button is not shown — so the browser never asks for a permission already refused
  ├─ location
  │    ├─ granted → coordinates + accuracy
  │    └─ denied / unavailable → continue without; the policy decides
  ├─ photo (if required)
  │    ├─ file input with camera → compressed on device to ≤ 800 px, JPEG 0.7
  │    │    → POST /api/attendance/photo (≤ 512 KB) → photoKey
  │    └─ refused → continue without; the policy decides
  ├─ tap "Masuk" / "Pulang" → POST /api/attendance/punch { type, coordinates?, photoKey?, dedupeKey }
  │    ├─ 200 accepted → confirmation with time
  │    ├─ 200 accepted + flags → confirmation + one plain-language message per flag, from the server
  │    ├─ 200 { duplicate: true } → treated as success
  │    ├─ blocked by policy (BLOCK, or FALLBACK_ONLY off the office network)
  │    │    → message naming what is missing and four ways forward
  │    └─ network failure → Flow 5
  └─ link to /attendance/me
```

## Flow 5: Punch (Offline)

```
/attendance/punch while offline
  ├─ banner: offline
  ├─ a photo cannot be taken offline (the queue carries no binary payload); a required photo is missing when the punch replays, and the policy decides
  ├─ tap → punch saved to IndexedDB with its dedupeKey and client time
  │    → "saved on this device, not yet sent" + count of queued punches
  ├─ navigator.storage.persist() requested; iOS users told to install to the home screen
  └─ 'online' event or next app open → flush queue
        ├─ each POST → 200 or { duplicate: true } → removed from queue
        ├─ 401, 429, 5xx → temporary: kept for the next flush
        ├─ other 4xx (e.g. blocked by policy) → permanent: dropped from the queue, so the "unsent" count can reach zero
        ├─ punches queued by a different user on the same device → left in the queue, not sent under this session
        └─ still offline → stays queued
```

The flush is idempotent: running it twice never creates a second punch (`../PLAN/12` Phase 3 DoD).

## Flow 6: Review a Flagged Punch

```
/attendance/review
  ├─ GET /api/attendance/review → up to 100 flagged punches, newest first, with the total count
  ├─ open one → evidence: time, flags with reasons, distance from site, accuracy, photo
  │    └─ photo → GET /api/attendance/photo/[key] (access logged, no-store)
  ├─ approve or reject, with a reason → POST /api/attendance/review → review, reviewer, time, and note recorded on the punch
  ├─ the employee sees the outcome in /attendance/me
  └─ queue empty → empty state
```

## Flow 7: Request Leave

```
/leave/me
  ├─ balance per leave type
  ├─ "Ajukan cuti" → type, dates, reason, approver (from GET /api/leave/approvers), attachment (≤ 5 MB)
  │    ├─ days counted from the work schedule and national holidays
  │    ├─ insufficient balance → refused (`insufficient_balance`)
  │    └─ chosen approver does not hold leave.request.approve → refused
  ├─ submit → pending; approver notified
  └─ cancel a pending request → confirm dialog → cancelled
```

## Flow 8: Approve Leave

```
/leave/approvals
  ├─ pending requests the user may decide
  ├─ approve → balance deducted under a row lock
  │    ├─ 200 → removed from the list
  │    ├─ 409 CONFLICT → "sudah diputuskan sebelumnya" (someone else acted first)
  │    └─ own request → refused, without exception
  └─ reject with a note
```

## Flow 9: Reach a Page Without Access

```
any page
  ├─ menu item absent → the user normally never gets here
  └─ direct URL
        ├─ module not subscribed → a 402 state: what the module does + link to subscription (target; `/modules/[code]` holds that content)
        ├─ permission missing → 403 state: "you do not have access to this page" + link home
        └─ token stale → silent refresh + retry → then one of the above
```

**Today no page renders a designed state for an API `402` or `403`**; the refusal appears as the page's generic error line. `/modules/[code]` is built but unlinked. `11-EMPTY-LOADING-ERROR-STATES.md` defines the target.

## Flow 10: Accept an Invitation

```
email → /accept-invitation?token=…
  ├─ valid → set password (12–128 characters) → account active
  └─ invalid, expired, or used → "Tautan tidak sah atau sudah kedaluwarsa" (or the server's message)
```
