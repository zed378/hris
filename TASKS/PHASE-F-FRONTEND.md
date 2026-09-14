# Phase F — Frontend Track

**A track, not a sequence position.** These tasks make the 32 built pages usable by the people in `docs/UI-UX/01` — especially employees on phones — without adding features. None is gated: they make Gates A and B testable.

**Plan refs for the whole track**: `docs/UI-UX/00`–`14`. Every task inherits `docs/UI-UX/14-UX-ACCEPTANCE-CRITERIA.md` §1 as part of its DoD.

**Order**: `PF-01` first (it makes every later change a one-place change), then `PF-20` (users currently read English server messages), then `PF-02` and `PF-04` (the two release-level UX gates R1 and R2 in `docs/UI-UX/14` §4), then the accessibility set.

---

## Delivered

The pages and components are listed in `docs/UI-UX/07-PAGE-INVENTORY.md` and `06-COMPONENT-SPECIFICATION.md`; they were delivered inside Phases 1–6 and are not repeated here.

---

## Open

### PF-01 — Extract the repeated UI patterns into components

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** — precondition for the rest of the track |
| **Depends on** | — |
| **Plan refs** | `docs/UI-UX/05` §7, `docs/UI-UX/06` §2 |
| **Spec required** | No — no behaviour change |
| **Surface** | web |
| **Size** | M |

**Goal** — `Button`, `Field`, `Card`, `EmptyState`, `ErrorLine`, `DataTable`, and `StatusBadge` exist in `apps/web/src/components/` and replace the copied class strings, with no visual change.

**Definition of Done**
- The five identical patterns in `docs/UI-UX/05` §7 have no remaining inline copies.
- Screens compared before and after at 360 px and 1280 px, light and dark — no difference except where noted.
- `frontend-boundary.test.ts` and `api-call-coverage.test.ts` still pass.

### PF-02 — Mobile navigation

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** — release gate R1 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/09` §3, `docs/UI-UX/03` §3–4, risk F6 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Goal** — below 768 px, every authenticated page offers navigation to every destination the user's menu contains, with home one tap away.

**Steps** — implement the ten requirements of `docs/UI-UX/09` §3: a bottom bar for pocket destinations and a drawer for the full tree, both rendered from `bootstrap.menu`, using the seeded icons with labels; the tenant name in the header links home; active state by section.

**Definition of Done**
- The seeded `EMPLOYEE` role reaches all eight destinations from any page at 360 px without the browser's back button.
- `HR_ADMIN` reaches every menu leaf through the drawer.
- Keyboard: drawer traps and returns focus; `Esc` closes.
- No second menu list in the frontend — asserted by a test that searches `apps/web/src` for hard-coded menu paths outside the app shell.
- `docs/UI-UX/09` §2, `docs/UI-UX/14` R1 and M1, risk F6 updated.

### PF-03 — Tables that scroll at phone width

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/09` §4, `docs/UI-UX/10` A-9 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — all 17 tables inside `overflow-x-auto` through `DataTable`; `<th scope="col">`; no horizontal page scroll at 360 px on any page.

### PF-04 — Refused state for `402` and `403`

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** — release gate R2 |
| **Depends on** | PF-01; uses the message catalogue from PF-20 |
| **Blocked by** | — |
| **Plan refs** | `docs/UI-UX/11` §5, `docs/UI-UX/00` principle 2 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Goal** — any page whose data request returns `402 MODULE_NOT_SUBSCRIBED` shows what the module does and how to get it; `403 PERMISSION_DENIED` shows a clear no-access state with a way home. `/modules/[code]` becomes reachable.

**Definition of Done**
- A shared `RefusedState` used by every page's error path for `status === 402 || 403`.
- Verified on three pages each with an unsubscribed tenant and a user lacking the permission.
- Owners see a link to `/settings/subscription`; others are told to contact the account owner.
- No permission code shown to users.

### PF-05 — Offline state on pages other than punch

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/11` §6, `docs/UI-UX/08` §7 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — with the network off, every pocket page says it needs a connection and recovers on the `online` event without a reload; nothing is cached to make this work (P16).

### PF-06 — Focus visibility, skip link, labelled navigation

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/10` A-2, A-7, A-8 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — every interactive element shows a `focus-visible` ring; a "Lewati ke konten" skip link; `<nav aria-label="Navigasi utama">`; a keyboard-only pass of five pages recorded.

### PF-07 — Page titles and focus on navigation

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Plan refs** | `docs/UI-UX/10` A-3, A-4 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — every page has a unique title ("Presensi Saya · HRMS"); after a route change focus moves to the page `<h1>`; verified with a screen reader on two pages.

### PF-08 — Announce async outcomes

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Plan refs** | `docs/UI-UX/10` A-5, `docs/UI-UX/11` §2 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — loading and success messages in `role="status"`, errors in `role="alert"`, on every page; the punch outcome and queue count announced (verified with TalkBack or VoiceOver).

### PF-09 — Field-level server errors

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/12` §2–3, `docs/UI-UX/10` A-6 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Definition of Done** — `VALIDATION_FAILED` `details` mapped onto fields on every form through `Field`, with `aria-invalid` and `aria-describedby`; focus moves to the first invalid field; unmapped errors in a summary; input kept.

### PF-10 — Images, contrast, and touch targets

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/UI-UX/10` A-10, A-11, A-12 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — every `<img>` has meaningful `alt`; contrast measured for secondary and hint text and fixed to 4.5:1; pocket-page controls ≥ 44 px.

### PF-11 — First-run setup guidance

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 — helps Gate A |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/11` §3, `docs/UI-UX/02` Journey 1 stage 2, `docs/UI-UX/14` R5 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — a tenant with no employees sees, on the home dashboard, the setup steps in order (import employees, add work sites, create accounts), each linking to its page and marked done when its data exists; shown only to users who can act on each step.

### PF-12 — HR views render other people's punch times in the tenant's time zone

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/UI-UX/08` §10, `docs/PLAN/13` §2.1 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — records, review queue, live dashboard, and device import render punch times in the tenant's (or site's) zone with the zone label; a test renders a WIT punch on a WIB device correctly.

### PF-13 — Browser end-to-end suite

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | P0-09 |
| **Plan refs** | `docs/PLAN/16` §2 and §4, `docs/UI-UX/04` |
| **Spec required** | No |
| **Surface** | web, ops |
| **Size** | L |

**Goal** — Playwright on Chromium and WebKit, against a real stack, covering Flows 1, 3, 4, 5, 6, 7, and 8 of `docs/UI-UX/04`, including the offline punch and the shared-device logout.

**Definition of Done** — the suite runs in CI; each flow shown to fail by breaking its key step once.

### PF-14 — Automated accessibility checks

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Depends on** | PF-13 |
| **Plan refs** | `docs/UI-UX/10` §5 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — axe runs inside the E2E suite on every page it visits; serious and critical violations fail the build.

### PF-15 — One error colour

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P3 |
| **Depends on** | PF-01 |
| **Plan refs** | `docs/UI-UX/05` §2 |
| **Size** | S |

**Definition of Done** — `rose-*` replaced by `red-*` for errors.

### PF-16 — Confirm discarding an import and closing a payroll run

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/UI-UX/08` §5 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — both actions confirm, naming the object and the consequence.

### PF-17 — Move the attendance policy out of the shifts page

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P3 |
| **Plan refs** | `docs/UI-UX/07` Observations, `docs/UI-UX/12` §6 |
| **Spec required** | No — no behaviour change; a new menu entry is seeded |
| **Surface** | web, db (seed) |
| **Size** | S |

### PF-18 — Mobile-friendly pocket pages

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | PF-01, PF-02 |
| **Plan refs** | `docs/UI-UX/09` §4 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Definition of Done** — `/attendance/me`, `/leave/me`, and `/payroll/me` use stacked rows below `sm`; primary actions full-width; `p-4` page padding below `sm`; `inputMode` set on numeric inputs.

### PF-19 — Warn about `ANNIVERSARY` on the leave policy screen

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P3 |
| **Plan refs** | `docs/PLAN/13` §5 Leave, `P4-12` |
| **Spec required** | No |
| **Surface** | web |
| **Size** | S |

**Definition of Done** — choosing `ANNIVERSARY` shows that `maxCarryOverDays` must equal the quota until anniversary-based periods exist.

### PF-20 — Indonesian message catalogue; never render server messages

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 — decided 2026-09-14 (`OQ-01`, ADR-030) |
| **Depends on** | PF-01 (`ErrorLine`, `Field`); `P6-24` step 2 for the full reason list |
| **Blocked by** | — (start with `code`; add reasons as `P6-24` lands) |
| **Plan refs** | `docs/UI-UX/13` §1 and §5, `docs/UI-UX/11` §4, `docs/PLAN/15` §6 |
| **Spec required** | No — no API change on this side |
| **Surface** | web |
| **Size** | M |

**Goal** — every word a user sees in the frontend is Indonesian and comes from the frontend, whatever language the backend answers in.

**Steps**
1. `apps/web/src/lib/messages.ts`: Indonesian text keyed by error `code`, then by `reason` where present, with interpolation from `details` (e.g. which evidence is missing). A generic fallback per status: "Terjadi kesalahan. Kode referensi: {correlationId}".
2. `ApiError` exposes `code`, `reason`, `details`, `correlationId`; pages render `messageFor(error)` — never `error.message`. About 30 places render the server message today.
3. Field-level validation text generated from Zod issue codes and bounds (`too_small`, `minimum: 12` → "Minimal 12 karakter"), shared with `PF-09`.
4. Translate the frontend's own English strings back to Indonesian: `apps/web/src/lib/push.ts` results, the `session.tsx` fallback, and any other found by the test in the DoD.
5. Keep `error.message` available to developers: logged to the browser console in development builds only.

**Definition of Done**
- A test fails if any page or component renders `.message` from an `ApiError` or a response body; seen to fail against the current code.
- A test compares the catalogue with `ErrorCode` in `packages/contracts` (and the reason list once `P6-24` defines it): every code and reason has Indonesian text.
- A test searches `apps/web/src/app` and `apps/web/src/components` and the user-facing strings in `apps/web/src/lib` for common English words in string literals, with an allowlist for identifiers; seen to fail by adding one.
- Checked by hand on the flows in `docs/UI-UX/04` with the backend returning English: no English reaches the screen.
- `docs/UI-UX/11` §4, `docs/UI-UX/13` §1, `docs/UI-UX/14` U9 verified.

