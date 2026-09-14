# 11 — Empty, Loading, Error, and Refused States

Every page fetches its data client-side through `api()` (`07-PAGE-INVENTORY.md`), so every page is responsible for every state below. A page is not done until each state is designed — the happy path is one state of six.

---

## 1. The Six States

| State | When | Today |
|---|---|---|
| **Loading** | Before the first response | Text: "Memuat…" in the shell and on pages (34 progress labels across pages) |
| **Empty** | Response succeeded, nothing to show | A bordered card with one sentence on 12 pages ("Belum ada pengajuan cuti", "Belum ada lokasi kerja") |
| **Content** | Data present | — |
| **Error** | Network failure, `4xx`/`5xx` | A red line with `ApiError.message` |
| **Refused** | `402 MODULE_NOT_SUBSCRIBED` or `403 PERMISSION_DENIED` | **Not distinguished from Error on any page** |
| **Offline** | The device has no connection | Designed on `/attendance/punch` only |

## 2. Loading

- **Text, not spinners or skeletons.** "Memuat…" is announced by screen readers when placed in `role="status"`, costs nothing, and does not shift layout much. Keep it.
- Show loading **in the region being loaded**, not over the whole page, once the shell has rendered.
- Keep previously loaded content visible while refetching after a mutation; disable the controls that would act on it.
- A load longer than ~10 seconds on a pocket page should say so ("Koneksi lambat…") rather than spin silently.

## 3. Empty

Two kinds, and they need different words.

| Kind | Example | Must say |
|---|---|---|
| **Nothing yet — the user can act** | No employees; no work sites; no leave types | What is empty, and the one action that fills it, as a button or link: "Belum ada karyawan. **Impor dari Excel**" |
| **Nothing yet — nothing to do** | No leave requests; review queue clear; no audit entries for a filter | What is empty, in a neutral or positive tone: "Tidak ada presensi yang perlu ditinjau" |
| **Nothing matches a filter** | A search with no results | That the filter is the reason, with a way to clear it |

**Never render a zero where the truth is "no data".** A month with no punches on the trend chart is a gap, not `0`; a balance the user may not see is "—", not `0` (`00-DESIGN-DIRECTION.md` principle 1).

**First-run empty home:** a new tenant's dashboard is empty until data exists. It should instead show the setup steps in order — import employees, add work sites, create accounts — each linking to its page (`02-USER-JOURNEYS.md` Journey 1 stage 2). Not built.

## 4. Error

| Cause | Message pattern | Action offered |
|---|---|---|
| Network failure (fetch throws) | "Tidak dapat terhubung. Periksa koneksi Anda." | "Coba lagi" |
| `400 VALIDATION_FAILED` | Field-level Indonesian messages built from the issue codes and bounds in `details`, beside each field; a summary at the top of the form | Fix and resubmit |
| `404 NOT_FOUND` | "Data tidak ditemukan" — it may have been deleted | Link to the list |
| `409 CONFLICT` | What conflicted, in words ("Sudah diputuskan sebelumnya") | Refresh the data |
| `410 Gone` | "Berkas sudah diarsipkan" | — |
| `429 RATE_LIMITED` | "Terlalu banyak percobaan. Coba lagi dalam N menit" from `retry-after` | Wait |
| `423 ACCOUNT_LOCKED` | Same, with the lock time | Wait; "Lupa kata sandi" |
| `500 INTERNAL` | "Terjadi kesalahan. Kode referensi: {correlationId}" | "Coba lagi"; the reference lets support find the log line |
| `503` | "Layanan sedang sibuk. Coba lagi sebentar lagi" | Automatic retry after `retry-after` where safe (reads only) |

Rules:

- **Never show the server's `message`** — it is English, for developers (ADR-030). Show the Indonesian text the frontend catalogue holds for the error's `code` and `reason` (`PF-20`); for anything unmapped and for 5xx, a fixed message and the **correlation id**. The message patterns in the table above are that catalogue's content.
- **Errors appear where the action was taken**, not only at the top of the page.
- **Errors are announced** (`role="alert"`).
- **A failed mutation never loses the user's input.** The form stays filled.

## 5. Refused (`402` / `403`)

The user reached something they cannot use — usually by a bookmark, an old link, or a role change mid-session. This is not an error and must not look like one (P9: the frontend hides, the backend refuses, and the refusal must be understandable).

| Response | Show | Offer |
|---|---|---|
| `402 MODULE_NOT_SUBSCRIBED` | The module's name and what it does — the content of `/modules/[code]` | To an owner: link to `/settings/subscription`. To others: "Hubungi pemilik akun perusahaan Anda" |
| `403 PERMISSION_DENIED` | "Anda tidak memiliki akses ke halaman ini" | Link home. Never list the missing permission code |
| `401 TOKEN_STALE` after refresh still failing | — | Handled by `api()`: session ends, `/login` |

Implementation target: `api()` already throws `ApiError` with `status` and `code`. A shared `RefusedState` rendered by pages for `status === 402 || status === 403` covers every page at once. **Not built** — `TASKS/`.

## 6. Offline

| Page type | Offline behaviour |
|---|---|
| `/attendance/punch` | Designed: banner, queue, count, flush (`04-USER-FLOWS.md` Flow 5) |
| Every other page | Should show "Tidak ada koneksi — halaman ini memerlukan internet" instead of the generic network error, and recover automatically on the `online` event. **Not built** |

Nothing but the app shell and punch queue is available offline, by design (P16).

## 7. Partial Data

The home dashboard assembles several sections, some of which may be `null` because the user lacks permission or the module is not subscribed. A `null` section **is not rendered**, rather than rendered empty. A section that failed to load says so in its own region and does not take the page down.

## 8. Checklist for Every Page

- [ ] Loading state in the region being loaded, in `role="status"`
- [ ] Empty state distinguishes "act" from "nothing to do" from "filtered out"
- [ ] Network error with retry
- [ ] 4xx and 5xx show catalogue text, never the server message; 5xx includes a reference id
- [ ] `402` and `403` render the refused state, not the error line
- [ ] Offline (pocket pages) says so and recovers
- [ ] A failed submit keeps the input
- [ ] No `0` where there is no data
