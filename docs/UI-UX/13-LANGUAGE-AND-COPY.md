# 13 — Language and Copy

How the product speaks. The interface is **Indonesian**; this document is in English because it is documentation. Examples are given in the Indonesian the user sees.

---

## 1. Which Language Where

| Surface | Language | Status |
|---|---|---|
| Every UI string: labels, buttons, headings, empty states, confirmations | Indonesian | Settled |
| Menu labels (seeded) | Indonesian | Settled |
| Documentation, code, comments, commit messages | English | Settled |
| Log messages | English | Settled |
| API responses, error `message`, validation messages, logs, debug output | **English** — never shown to users | **Decided 2026-09-14** (ADR-030); backend completion is `P6-24` |
| Error text users see | Indonesian, from the frontend's catalogue keyed by error `code` and `reason` | Decided; `PF-20` |
| Emails and push notifications | Currently English | **Open: `OQ-15`** |

**The frontend never renders the server's `message`.** It maps `code` (and `reason`, once `P6-24` adds it) to Indonesian text in one catalogue (`PF-20`). Until that lands, some pages still show the server message — which may now be English. Data the frontend displays from the database — seeded menu labels, leave-type and holiday names — is frontend content and stays Indonesian.

## 2. Voice

| Is | Is not |
|---|---|
| Plain, the way an HR officer talks to a colleague | Legal, bureaucratic, or the language of a regulation |
| Direct: says what happened and what to do | Apologetic or chatty |
| Neutral about evidence | Accusing ("curang", "pelanggaran") |
| Honest about uncertainty | Reassuring beyond what the system knows |

## 3. Address and Tone

- Address the user as **"Anda"**. Never "kamu" (too casual for a workplace tool) and never third person.
- Sentence case for headings and buttons: "Ajukan cuti", not "Ajukan Cuti" — **except** menu labels, which are seeded in title case ("Daftar Karyawan") and stay consistent with themselves.
- No exclamation marks except in a genuine success after a long task ("Impor selesai!") — and sparingly even then.

## 4. Vocabulary

Use one word for one thing, everywhere.

| Concept | Use | Avoid |
|---|---|---|
| Clock in / clock out | **Masuk** / **Pulang** (buttons); **absen masuk** / **absen pulang** (sentences) | check-in, tap in |
| Attendance record | **Presensi** | absensi (means *absence* to some readers), kehadiran as a noun for one record |
| Attendance recap | **Rekap kehadiran** | laporan absen |
| Flagged, needs review | **Perlu ditinjau** | mencurigakan, ditolak otomatis |
| Leave request | **Pengajuan cuti** | permohonan izin |
| Approve / reject | **Setujui** / **Tolak** | acc, approve |
| Payslip | **Slip gaji** | payslip |
| Payroll run | **Proses gaji** | payroll run |
| Employee | **Karyawan** | pegawai, staf |
| Company account (tenant) | **Akun perusahaan** | tenant |
| Company code | **Kode perusahaan** | tenant code |
| Subscription / plan | **Langganan** / **paket** | subscription |
| Module | **Modul** | fitur (a module is more than a feature) |
| Role / permission | **Peran** / **hak akses** | role, permission |
| Work site | **Lokasi kerja** | site, cabang (a branch is not always a site) |
| Consent | **Persetujuan data** | consent |
| Sign in / sign out | **Masuk** (page) / **Keluar** | login, logout |
| Trial | **Uji coba** | trial |

"Masuk" means both *sign in* and *clock in*. They never appear on the same screen, which keeps it workable; do not put a sign-in link on the punch page.

**Never show system words to tenants:** tenant, RLS, token, permission code (`attendance.review.handle`), module code, correlation id (except as "kode referensi" on a 5xx).

## 5. Patterns

### Errors

Say what happened and what to do, in that order. No blame.

- ✅ "Presensi tanpa lokasi hanya dapat dilakukan dari jaringan kantor. Sambungkan perangkat ke jaringan kantor, aktifkan izinnya di setelan peramban, gunakan mesin absensi, atau minta HR memasukkan koreksi manual." (the punch refusal — sent by the server today; after `P6-24` and `PF-20` this text lives in the frontend catalogue, keyed by the refusal's reason)
- ❌ "Error: location required"

### Empty states

State what is empty, then the action: "Belum ada lokasi kerja. **Tambah lokasi kerja**".

### Confirmations

Name the object and the consequence: "Arsipkan \"KTP Sari\"? Berkasnya akan dihapus permanen." Button labels are verbs ("Arsipkan"), never "OK".

### Evidence and flags

Describe the observation, not the person, with the measured value where there is one. The real messages from `packages/core/src/attendance/trust.ts` follow this: "320 m dari lokasi kerja (radius 100 m)", "Akurasi GPS 85 m (batas 50 m)", "Tanpa foto — persetujuan foto tidak diberikan", "Presensi dari peramban — keaslian lokasi tidak dapat diverifikasi". The employee sees the same words HR sees.

### Offline

"Tersimpan di perangkat ini, belum terkirim." Then, when sent: "Terkirim." Never "Berhasil" for something still queued.

### Privacy explanations

Before asking for a permission, say what is collected, when, who sees it, how long it is kept, and what happens if the user says no — in that order, in short sentences (`/attendance/consent`).

## 6. Numbers, Dates, and Currency

| | Format |
|---|---|
| Money | `Rp 5.250.000` — `Intl.NumberFormat('id-ID')`, no decimals |
| Numbers | `1.250` (dot thousands), `12,5` (comma decimal) |
| Dates | `Senin, 14 September 2026` in headings; `14 Sep 2026` or `14/09/2026` in tables |
| Times | `08.02` (dot); with zone when it matters: `08.02 WIT` |
| Durations | `2 hari`, `3 jam 15 menit` |
| Months | Indonesian names (the dashboard's `BULAN` array) |

## 7. Checklist

- [ ] Every new string is Indonesian and uses the vocabulary table
- [ ] "Anda", sentence case, no system words
- [ ] Errors say what happened and what to do
- [ ] Empty states name the next action where there is one
- [ ] Confirmations name the object and consequence; buttons are verbs
- [ ] Flags describe observations, not people
- [ ] Money, numbers, dates, times use `id-ID` formatting
- [ ] No server `message` rendered; error text comes from the frontend catalogue
