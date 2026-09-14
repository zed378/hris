# 10 — Accessibility

The accessibility target, what the frontend does today, and the gaps in priority order. Measured by searching `apps/web/src` on 2026-09-13. **No audit with a screen reader or an automated checker (axe, Lighthouse) has been run.**

---

## 1. Target

**WCAG 2.2 Level AA** for every tenant-plane page. The users include older HR staff, employees with low vision using large text, and people on small, bright-lit phone screens outdoors at a site gate. An inaccessible punch screen is an employee who cannot be paid correctly.

## 2. What Is Already Right

| Practice | Evidence |
|---|---|
| Document language set | `<html lang="id">` |
| Zoom never locked | No `maximum-scale` in the viewport; the reason is commented in `app/layout.tsx` |
| Form labels associated | 43 `<label>` elements wrap their inputs (implicit association) |
| Native controls | `<button>`, `<a>`, `<select>` (21), `<input type="date">` (12) — keyboard and screen-reader support for free; no clickable `div`s found |
| Chart has a text alternative | `TrendChart`: `role="img"`, `aria-label` summary, `<title>` per point, missing months named |
| Some errors announced | `role="alert"` on login, import, and token password forms (3) |
| Colour is not the only signal | Flags, statuses, and trial state carry words |
| Dark mode | Follows the system preference |
| Destructive confirmations | Native `window.confirm` — accessible by default |

## 3. Gaps, in Priority Order

| # | Gap | Measure | WCAG | Fix |
|---|---|---|---|---|
| A-1 | **No mobile navigation** — keyboard and switch users on phones are stranded the same way everyone else is | `09` §2 | 2.4.5 Multiple Ways, 2.4.1 | `09` §3 |
| A-2 | **Focus visibility is not designed.** Inputs get `focus:border-brand-500` (17); buttons and links rely on the browser default, which several class combinations weaken; no `focus-visible` styles anywhere | 0 `focus-visible` | 2.4.7, 2.4.11 | `focus-visible:ring-2 ring-brand-500 ring-offset-2` on the extracted `Button`, links, and menu items |
| A-3 | **Every page has the same document title, "HRMS"** — pages are client components and the root layout sets one title | 1 `metadata` title for 30 tenant pages | 2.4.2 Page Titled | Per-route `layout.tsx` metadata, or `document.title` set on route change: "Presensi Saya · HRMS" |
| A-4 | **Route changes are not announced and focus is not moved.** After navigating, focus stays on the clicked link in the sidebar | 0 focus management | 2.4.3, 4.1.3 | Move focus to the page `<h1>` on route change |
| A-5 | **Async results are not announced.** Punch outcome, "saved", "approved", queue count changes — none is in a live region | 0 `aria-live`, 0 `role="status"` | 4.1.3 Status Messages | `role="status"` on success and progress; `role="alert"` on errors |
| A-6 | **Field errors are not tied to fields.** Field-level errors render on 2 pages (register, sites); nowhere with `aria-describedby` / `aria-invalid` | 0 `htmlFor`, 1 `aria-` attribute in the codebase | 3.3.1, 3.3.3, 1.3.1 | `Field` component (`12-FORM-UX.md`) |
| A-7 | **No skip link** past a sidebar of up to 27 links | 0 `sr-only` | 2.4.1 Bypass Blocks | "Lewati ke konten" link as the first focusable element |
| A-8 | **Landmarks incomplete.** `<aside>`, `<header>`, `<main>` exist; the sidebar `<nav>` has no label; the group headings are `<p>` | — | 1.3.1 | `<nav aria-label="Navigasi utama">`; group headings as headings or `aria-labelledby` groups |
| A-9 | **Table headers lack `scope`** | 17 tables | 1.3.1 | `<th scope="col">` in `DataTable` |
| A-10 | **Images:** 1 `alt` attribute in the codebase; attendance photos in the review queue need a text alternative ("Foto presensi Sari, 08.02") | 1 `alt` | 1.1.1 | `alt` on every `<img>` |
| A-11 | **Contrast unverified.** `text-slate-400` on white (hints, group headings) is likely below 4.5:1; `text-slate-500` on `slate-50` is borderline | Not measured | 1.4.3 | Measure; move small text to `slate-600` / dark `slate-300` |
| A-12 | **Touch targets** of secondary buttons (`px-3 py-1.5 text-sm`, ≈ 32 px tall) and table link actions are below 44 px on phones | — | 2.5.8 Target Size (24 px min AA) | Meets AA's 24 px; raise to 44 px on pocket pages |
| A-13 | **Timeouts:** a 15-minute access token refreshes silently, so no user-facing timeout exists — keep it that way | — | 2.2.1 | — |

## 4. Rules for New Work

1. Native elements first. A `div` with `onClick` is a defect.
2. Every input has a visible label — never a placeholder instead of a label.
3. Every page has one `<h1>` and a unique document title.
4. Every async outcome the user waits for is announced (`role="status"` or `role="alert"`).
5. Every interactive element shows focus with `focus-visible`.
6. Colour never carries meaning alone.
7. Every `<img>` has `alt` (empty `alt=""` only when decorative — and nothing here should be decorative).
8. Test each change with keyboard only, and at 200% browser zoom.

## 5. Verification

| Check | How | Cadence |
|---|---|---|
| Keyboard-only pass of touched pages | Tab through; every action reachable; focus always visible | Every UI change |
| Automated | axe DevTools or Lighthouse accessibility on touched pages | Every UI change — **not yet done once** |
| Screen reader | TalkBack on Android on the punch flow; NVDA or VoiceOver on one desk flow | Before Gate A pilots |
| Zoom | 200% at 1280 px; 360 px with large system font | Every UI change |
| Contrast | Measure A-11 once; add token rules | Once, then on palette change |
