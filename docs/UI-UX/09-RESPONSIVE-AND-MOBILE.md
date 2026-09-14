# 09 — Responsive Behaviour and Mobile UX

How the interface adapts from a 360 px phone to a laptop, and what the pocket product needs that the desk product does not. This is the weakest area of the current frontend, and the one that decides whether employees — most of the product's users by headcount — can use it.

---

## 1. Breakpoints

Tailwind defaults.

| Name | Min width | Used in the code |
|---|---|---|
| (base) | 0 | Everything |
| `sm` | 640 px | 28 uses — mostly two-column form rows |
| `md` | 768 px | **1 use: showing the sidebar** |
| `lg` | 1024 px | 10 uses — dashboard grids |

**Design target widths:** 360 px (a common mid-range Android), 390 px (iPhone), 1280 px (a small laptop), 1440 px.

## 2. The Current State at Phone Width

| Element | Below 768 px |
|---|---|
| Sidebar | **Hidden** (`hidden … md:block`) |
| Replacement navigation | **None** |
| Header | Visible: trial badge, user name, "Keluar" |
| Link back to home | **None** — the tenant name lives in the hidden sidebar |
| Home dashboard | Cards stack; cards link onward to punch, my leave, my payslip, approvals, and more depending on role and data |
| Tables | 13 of 17 scroll horizontally in `overflow-x-auto`; **4 do not** and can overflow the page |
| Main padding | `p-6` (24 px) — generous at 360 px, leaving 312 px of content |
| Punch page | Usable; the most mobile-considered page |

**Consequence:** from any page other than home, an employee on a phone has only the browser's back button. `/attendance/me`, `/attendance/consent`, and every settings page have no path at all except the PWA shortcut (for `/attendance/me`) or a typed URL.

This is risk `F6` in `../PLAN/22-RISK-REGISTER.md` and the top frontend task in `TASKS/`.

## 3. Mobile Navigation — Specification

To be built. Requirements, not a visual design:

1. **Visible on every authenticated page below `md`.** The desktop sidebar is unchanged.
2. **Rendered from the same `bootstrap.menu`.** No second menu list in the frontend (`03` rule).
3. **Pocket destinations first.** For a user whose visible leaves are only "mine" pages (the seeded `EMPLOYEE` role sees eight destinations), a **bottom navigation bar** with up to five items: Beranda, Absen, Presensi Saya, Cuti, Slip Gaji. Anything else goes behind a "Lainnya" item.
4. **Desk destinations behind a menu.** For users with administration pages, a header button opening the full menu tree as a drawer — same grouping as the sidebar.
5. **Uses the seeded icons** (`home`, `clock`, `calendar`, `wallet`, `users`, `settings`) **with a text label** under each. Icon-only navigation is not allowed.
6. **Home is always one tap away.**
7. **Touch targets ≥ 44 × 44 px**; the bar respects `env(safe-area-inset-bottom)` in the installed PWA.
8. **Active state** marks the current section, not only an exact path match.
9. **Keyboard and screen reader:** a `<nav aria-label="Navigasi utama">`; the drawer traps focus while open and returns it on close; `Esc` closes.
10. **Tested** at 360 px on a real Android device and in WebKit.

## 4. Responsive Rules for Every Page

| Rule | Why |
|---|---|
| Works at 360 px with no horizontal page scroll | Most employees' phones |
| Every table inside `overflow-x-auto` | A wide table must scroll, not break the page |
| On pocket pages, prefer stacked rows ("cards") over tables below `sm` | `/attendance/me` and `/leave/me` are read on phones |
| Forms are one column below `sm` | Two narrow inputs side by side are unusable with a thumb |
| Primary action full-width below `sm` on pocket pages | Reachable with a thumb |
| Main padding `p-4` below `sm`, `p-6` above | 24 px on each side is a large share of 360 px |
| No hover-only affordances | Phones have no hover |
| Date inputs use native `type="date"` (12 uses) | The native picker is the best one on a phone |
| Numeric inputs use `inputMode="numeric"` / `"decimal"` (1 use today) | Brings up the number keypad |

## 5. The Pocket Product

### Performance budget

The morning punch happens on mid-range phones on mobile data (`../PLAN/18-PERFORMANCE-AND-CAPACITY.md` §6).

| Budget | Target | Source |
|---|---|---|
| Lighthouse Performance, mobile profile | ≥ 90 | `../PLAN/12` Phase 3 DoD — **not yet measured** |
| Lighthouse PWA | 100 | Same |
| Photo upload | ≤ 512 KB, compressed on device to ≤ 800 px | `capture-photo.ts` |
| Web fonts | None | `05-DESIGN-SYSTEM.md` §1 |

### Installed PWA

| | |
|---|---|
| Display | `standalone`, portrait |
| Shortcuts | "Presensi" → `/attendance/punch`; "Presensi Saya" → `/attendance/me` |
| iOS | Installing to the home screen is what keeps the offline queue from eviction and enables push; the punch page says so |
| Standalone detection | `display-mode: standalone` media query or `navigator.standalone` (`lib/push.ts`) |

In standalone mode there is **no browser back button** on iOS. Without mobile navigation, an installed employee who leaves home cannot return except by closing the app. That makes §3 more urgent for installed users than for browser users.

### Shared devices

The logout button stays visible in the header at every width. Logout wipes caches and the push subscription (`../SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md` §16). Offline punches queued by another user are left in the queue, not sent under the new session.

## 6. Verification

- [ ] Every page touched checked at 360 px and 1280 px, in light and dark
- [ ] No horizontal page scroll at 360 px
- [ ] Every pocket page reachable from every other pocket page without the browser's back button (fails today)
- [ ] Installed PWA on Android and iPhone: navigate, punch offline, reconnect, log out (not done)
- [ ] Lighthouse mobile run recorded in `MEMORY/records/` (not done)
