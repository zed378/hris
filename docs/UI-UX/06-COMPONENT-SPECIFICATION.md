# 06 — Component Specification

The components that exist, the inline patterns that behave like components, and the specification each should meet. Components live in `apps/web/src/components/`; page-local helpers live inside the page file.

---

## 1. Shared Components That Exist

### `AppShell` — `components/app-shell.tsx`

| | |
|---|---|
| Purpose | Route guard, dynamic sidebar, header with trial badge, user name, and logout |
| Behaviour | `anonymous` → redirect to `/login`. Not yet authenticated → full-screen "Memuat…". Menu rendered from `bootstrap.menu`; groups (no `path`) render as a heading; `prefetch={false}` on menu links |
| Must | Never contain a hard-coded menu entry. Never be the security boundary (P9) |
| Gaps | No mobile navigation; sidebar `hidden … md:block`. Seeded menu icons not rendered. Tenant name not a link home. Active state matches exact path only, so a detail route under a menu item shows nothing active |

### `TrendChart` — `components/trend-chart.tsx`

| | |
|---|---|
| Purpose | Six-month trend on the home dashboard |
| Behaviour | Inline SVG, `role="img"` with an `aria-label` summarising the series; each point has a `<title>`; a month with no data is drawn as a gap and titled "tidak ada data" — never as zero |
| Must | Keep `null` distinct from `0`. Keep the text summary |

### `TokenPasswordForm` — `components/token-password-form.tsx`

| | |
|---|---|
| Purpose | Shared by `/reset-password` and `/accept-invitation`: read a token from the URL, set a password |
| Behaviour | Error shown in a `role="alert"` region; fallback message "Tautan tidak sah atau sudah kedaluwarsa"; link back to login |

### `ServiceWorker` — `components/service-worker.tsx`

Registers `public/sw.js`. Renders nothing. Caching rules are in `../PLAN/11-PWA-Frontend.md` §3.2 and are security-relevant (`../SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md` §16).

## 2. Inline Patterns That Should Become Components

Each is copied across pages today. The specification below is what the extracted component must do — including behaviour the copies do not all have.

### `Button`

| Variant | Use | Classes today |
|---|---|---|
| `primary` | The one main action of a screen or form | `bg-brand-600 text-white hover:bg-brand-700` |
| `secondary` | Other actions | `border border-slate-300 hover:bg-slate-50` |
| `link` | Inline actions in tables | `text-brand-600 underline` |
| `danger` | Archive, cancel, reject — **not yet a distinct style** | — |

Must: `disabled:opacity-50` **and** a text change while busy ("Menyimpan…"), so the state is not colour-only. A visible focus ring (`focus-visible:ring-2 ring-brand-500`). `type="button"` unless it submits. At least 44 × 44 px touch target in the pocket product.

### `Field` (label + input + hint + error)

Today: `<label className="block"><span>Label</span><input …/></label>` — implicit association, which works with assistive technology. Must add: an error message tied with `aria-describedby`, `aria-invalid` when invalid, and `required` where the schema requires it (3 uses today). Spec in `12-FORM-UX.md`.

### `Card` / `Kartu`

The home dashboard defines a local `Kartu` (label, value, hint, `href`, `tone`). Must: the whole card is one link; `value` of `null` renders "—" with a hint, never `0`; `tone="perhatian"` uses amber **and** hint text.

### `EmptyState`

`rounded-lg border bg-white p-10 text-center text-sm text-slate-500` with one sentence, e.g. "Belum ada pengajuan cuti". Must: say what is empty **and** what to do next when the user can act ("Impor dari Excel"). `11-EMPTY-LOADING-ERROR-STATES.md`.

### `ErrorLine`

`rounded-md bg-red-50 px-3 py-2 text-sm text-red-800` showing `ApiError.message`. Must: `role="alert"` (3 uses today); distinct rendering for `402` and `403` (none today).

### `DataTable`

17 `<table>` elements, 13 wrapped in `overflow-x-auto`. Must: always wrapped for horizontal scroll; `<th scope="col">`; numeric columns right-aligned with `tabular-nums`; an empty state inside the table region, not instead of the page.

### `StatusBadge`

`rounded-full px-3 py-1 text-xs font-medium` in semantic colours. Must: text always present; the same status always the same colour everywhere (accepted = emerald, flagged/pending = amber, rejected = red).

### `ConfirmDialog`

Today `window.confirm` in two places: archiving a document ("Berkasnya akan dihapus permanen") and cancelling leave. Acceptable for now — native, accessible, works on every phone. Must when replaced: name the object and the consequence, default focus on the safe choice, `Esc` cancels.

## 3. Third-Party Components

### AG Grid (`ag-grid-community` / `ag-grid-react` 36) — `/employees/grid`

The Excel-like editing surface (`00` principle 3). Must: saves through `POST /api/employees/bulk`, never cell by cell to separate endpoints; masked PII columns stay masked unless the user holds `employee.pii.unmask`; keyboard navigation is AG Grid's own and must not be overridden.

Use AG Grid only where spreadsheet-style editing is the point. A read-only list is a `DataTable`.

## 4. Pocket-Product Components

Specific to `/attendance/punch`; not reused elsewhere and should not be generalised prematurely.

| Component (in page) | Must |
|---|---|
| Punch buttons "Masuk" / "Pulang" | Large, full-width on a phone, disabled while a punch is in flight |
| Location control | Hidden without location consent, so the browser never asks for a refused permission; states `asking`, `granted`, `denied`, `unavailable` shown in words |
| Photo control | File input with the camera; compressed on the device (≤ 800 px, JPEG 0.7) before upload |
| Offline banner + queue count | Visible while offline and while anything is queued ("N presensi menunggu terkirim"); "Coba kirim sekarang" to flush |
| Outcome panel | Time; one line per flag with the server's message; never a success colour on a flagged punch |
