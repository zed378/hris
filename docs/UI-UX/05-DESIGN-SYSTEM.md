# 05 — Design System

The visual foundations: colour, type, spacing, shape, and theme. There is **no component library and no design-token file beyond five brand colours** — styles are Tailwind 4 utility classes written inline on each page. This document records the conventions those classes already follow, so a new page matches the existing ones, and names the tokens worth extracting.

Source: `apps/web/src/app/globals.css`, and class frequencies measured across `apps/web/src` on 2026-09-13.

---

## 1. Foundations

| | Value |
|---|---|
| Styling | Tailwind CSS 4 (`@import 'tailwindcss'`), utilities inline |
| Font | System font stack (Tailwind default). No web font is loaded — deliberately cheap on slow networks |
| Theme | Light by default; **dark follows `prefers-color-scheme`** (`color-scheme: dark`). No manual toggle |
| Zoom | Not locked. `viewport` sets `width=device-width, initial-scale=1` and no `maximum-scale` — see the comment in `app/layout.tsx` |
| Theme colour | `#2f5fd0` (manifest and viewport) |
| Document language | `lang="id"` |

## 2. Colour

### Brand

Defined in `globals.css` under `@theme`:

| Token | Value | Used for |
|---|---|---|
| `brand-50` | `oklch(0.97 0.02 250)` | Active menu item background |
| `brand-100` | `oklch(0.93 0.04 250)` | Active menu item text (dark) |
| `brand-500` | `oklch(0.55 0.16 250)` | Input focus border (`focus:border-brand-500`, 17 uses) |
| `brand-600` | `oklch(0.48 0.16 250)` | Primary button; text links |
| `brand-700` | `oklch(0.41 0.14 250)` | Primary button hover; active menu text |

**Rule: brand marks the primary action and the current location.** Nothing decorative (`00-DESIGN-DIRECTION.md` §7).

### Neutrals

Tailwind `slate` throughout.

| Role | Light | Dark |
|---|---|---|
| Page background | `slate-50` | `slate-950` |
| Surface (card, sidebar, header) | `white` | `slate-900` |
| Border | `slate-200` (surfaces), `slate-300` (inputs, secondary buttons) | `slate-800`, `slate-700` |
| Primary text | `slate-900` | `slate-100` |
| Secondary text | `slate-500` / `slate-600` | `slate-400` |
| Hover fill | `slate-50` / `slate-100` | `slate-800` |

### Semantic

| Meaning | Light | Dark | Used for |
|---|---|---|---|
| Success / accepted | `emerald-50` bg, `emerald-800` text | `emerald-950` bg | Accepted punch, approved request |
| Attention / flagged / trial | `amber-50`–`amber-100` bg, `amber-800` text | `amber-950` bg | Flagged punch, trial badge, offline queue |
| Error / refused | `red-50` (or `rose-50`) bg, `red-800` text | `red-950` bg | Error lines, rejected |

**Gap:** `red` and `rose` are both used for errors. Pick one (`red`) when a page is next touched.

**Rule:** colour is never the only carrier of meaning. A flagged punch says "perlu ditinjau" in words; the amber is reinforcement (`10-ACCESSIBILITY.md`).

## 3. Typography

| Role | Class | Occurrences |
|---|---|---|
| Page title | `text-xl font-semibold` | 24 |
| Section title | `text-lg font-medium` | 8 |
| Large figure (dashboard card) | `text-2xl` | 14 |
| Body, table, form | `text-sm` | 374 — the dominant size |
| Caption, hint, badge | `text-xs` | 135 |
| Page description under title | `mt-1 text-sm text-slate-500` | 37 |
| Numbers in tables | `text-right tabular-nums` | 11 |

Body copy is `text-sm` (14 px). That is dense by design for the desk product; the pocket product's punch buttons and results are larger. **Never go below `text-xs` (12 px).**

## 4. Spacing and Layout

| Element | Convention |
|---|---|
| Page padding | `p-6` inside `main` |
| Sidebar width | `w-64` (256 px), hidden below `md` |
| Section spacing | `mb-5` between header and content |
| Card padding | `p-4`; empty-state card `p-10` |
| Table cell | `px-3 py-2` / `py-2 pr-4` |
| Input | `px-3 py-2`, `mt-1 w-full` under its label |
| Inline groups | `flex items-center gap-2` |

## 5. Shape and Elevation

| Element | Radius | Elevation |
|---|---|---|
| Buttons, inputs, menu items | `rounded-md` | none |
| Cards, panels, empty states | `rounded-lg` + `border` | none |
| Badges (trial, status) | `rounded-full` | none |

**Borders, not shadows.** Elevation is expressed by a white surface with a `slate-200` border on a `slate-50` page. Keep it that way; shadows read poorly in dark mode and add nothing on a phone.

## 6. Motion

`transition` on hover and active states only. No entrance animation, no skeleton shimmer. Loading is text (`11-EMPTY-LOADING-ERROR-STATES.md`).

## 7. Tokens Worth Extracting

The same long class strings repeat across pages. Extracting them into components (see `06-COMPONENT-SPECIFICATION.md`) would make the system enforceable instead of conventional:

| Pattern | Occurrences | Extract as |
|---|---|---|
| `rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white …` | 8 identical | `Button variant="primary"` |
| `rounded-md border border-slate-300 px-3 py-1.5 text-sm …` | 8 identical | `Button variant="secondary"` |
| `mt-1 w-full rounded-md border border-slate-300 px-3 py-2 …` | 11 identical | `Input` |
| `rounded-lg border border-slate-200 bg-white p-10 text-center …` | 12 identical | `EmptyState` |
| `rounded-lg border border-slate-200 bg-white p-4 …` | 9 identical | `Card` |

Extraction is a refactor with no visual change — a good first frontend task, and the precondition for fixing focus visibility (`10`) in one place instead of forty.
