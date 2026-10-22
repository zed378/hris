# PF-02 — Mobile navigation

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Task** | `TASKS/PHASE-F-FRONTEND.md` § PF-02 |
| **Phase** | Frontend track |
| **Surface** | web |
| **Author** | Agent (Claude Code) |
| **Commits** | `PF-02: bottom bar and drawer below md, rendered from bootstrap.menu` |
| **Spec** | Not required (card) |
| **Status** | Completed. `docs/UI-UX/09` §3 item 10 (real Android device, WebKit) is still outstanding and belongs to `P3-15` |
| **Reconstructed** | No |

---

## What Changed

Below `md`, every authenticated page has:
- a bottom bar with up to five pocket destinations (Beranda, Absen Sekarang, Presensi Saya, Cuti Saya, Slip Gaji Saya) and a "Lainnya" item;
- a drawer with the full menu tree, grouped the same way as the sidebar;
- the tenant name in the header, which links home, and a "Menu" button.

The desktop sidebar is unchanged. Risk F6 is closed.

## Why

Risk F6, release gate R1. Before this, the sidebar was hidden below `md` and nothing replaced it, so on a phone the browser's back button was the only way off any page.

## How

- `apps/web/src/lib/mobile-menu.ts` picks the bar's destinations **by menu code**. It never names a path, and every label, path and icon still comes from the server. A leaf with no icon of its own takes its group's icon (seeded leaves have none).
- `apps/web/src/components/mobile-nav.tsx` renders the bar and the drawer. While the drawer is open: focus moves into it, `Tab` stays inside it, `Esc` closes it, and the page behind does not scroll. On close, focus returns to the control that opened it. Navigating also closes it.
- `AppShell` holds the drawer's open state, because two controls open it.
- `viewportFit: 'cover'` is set so that `env(safe-area-inset-bottom)` is not always 0 in the installed PWA.

An earlier session had left an uncommitted draft. It hard-coded five menu paths (the "second menu list" the DoD forbids), and its "Keluar" button only closed the drawer. It closed the drawer on navigation by sending a fake `mousedown`, and it used `pb-safe` and `touch-target`, two Tailwind classes defined nowhere. The draft's `mobile-menu.ts` was sound and was kept. The component was rewritten on top of it.

## Verification

- `apps/web/test/mobile-menu.test.ts`:
  - Reachability: every leaf is in the bar or behind "Lainnya", exactly once.
  - Bar order, icon inheritance, and prefix-based active state.
  - The "no second menu list" guard. It reads menu paths from the seed and fails if any file in `src/components` or `src/lib` holds two or more of them. Against the draft it failed, naming `mobile-nav.tsx` and its five paths.
- Chromium (Playwright) at 360 × 740, logged in as `staff@demo.test` and `hr@demo.test`:
  - Bar items measure 60 × 56–66 px.
  - Every leaf appears in the drawer: 6 for EMPLOYEE, 26 for HR.
  - `Tab` never leaves the drawer, `Esc` closes it, focus returns to "Lainnya", and navigating closes it.
  - No horizontal scroll.
- Lint and typecheck are clean. Run locally; there is no CI run for this change.

## Discrepancy

The card says the seeded `EMPLOYEE` role sees **eight** destinations. The seed sends six: home, punch, my attendance, consent, my leave, my payslips. All six are reachable. The card's number is wrong, not the build.

## Not Done

- Real Android device and WebKit (`P3-15`, blocked on devices).
- Tables at phone width (`PF-03`).
