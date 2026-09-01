# Indonesian-to-English Translation Plan

Translate all Indonesian comments, error messages, user-facing UI strings, email templates, and CLI output to English across the HRIS monorepo.

## Scope

All packages and apps in the monorepo **except** `node_modules` and `apps/auth` (admin-only auth server — out of scope, not user-facing).

**35 files** total containing Indonesian text: ~1500+ lines including doc-blocks, inline comments, error messages, email templates, and UI strings.

## Translation Rules

- **Doc-blocks** (`/** */`): Translate meaning, preserve technical detail and structure.
- **Inline comments** (`//`): Translate directly.
- **Hardcoded string literals** (error messages, UI labels, email bodies): Translate to semantically equivalent English.
- **Month names** in `formatDate()`: Translate to English (Januari → January, etc.)
- **Do NOT touch**: Test `it()`/`describe()` descriptions, code variable names, API contract values (e.g., `"KTP"`, `"KITAS"` are proper Indonesian document type codes and should remain as-is).

## File-by-File Tasks (Ordered by Dependency)

### Priority 1: Core Authentication (packages/core/src/auth/)

No internal dependencies on other modified files.

| File | Indonesian String → English |
|------|---------------------------|
| `packages/core/src/auth/login.ts`<br>~8 strings | `'Kredensial tidak sah'` → `'Invalid credentials'`<br>`'Akun perusahaan sedang tidak aktif'` → `'Company account is temporarily inactive'`<br>`'Akun terkunci sementara karena terlalu banyak percobaan gagal'` → `'Account temporarily locked due to too many failed attempts'`<br>`'Email tidak ada atau sudah digunakan...'` → `'Email does not exist or is already in use. Enter a different email or use the company code.'`<br>`'Refresh token tidak sah'` (×2) → `'Invalid refresh token'`<br>`'Sesi Anda telah berakhir. Silakan masuk kembali.'` → `'Your session has ended. Please sign in again.'`<br>`'Refresh token kedaluwarsa'` → `'Refresh token expired'` |
| `packages/core/src/auth/tokens.ts`<br>2 strings | `'Token akses kedaluwarsa'` → `'Access token expired'`<br>`'Token akses tidak sah'` → `'Invalid access token'` |
| `packages/core/src/auth/jwt.ts`<br>2 strings | `'Token kedaluwarsa'` → `'Token expired'`<br>`'Token tidak sah'` → `'Invalid token'` |
| `packages/core/src/auth/action-tokens.ts`<br>2 × string | `'Tautan tidak sah atau sudah kedaluwarsa'` (×2) → `'Invalid or expired link'` |

### Priority 2: Core Business Logic

Depends on: none (standalone packages).

| File | Indonesian String → English |
|------|---------------------------|
| `packages/core/src/leave/balance.ts`<br>1 string | `'Saldo gagal dibuat'` → `'Balance creation failed'` |
| `packages/core/src/leave/requests.ts`<br>1 string | `'Pengajuan ini sudah disetujui previously'` → `'This request has already been'` (fix the existing mix: `'This request has already been approved/decided'`) |
| `packages/core/src/employee/bulk-update.ts`<br>2 strings | `'Nomor karyawan sudah dipakai orang lain'` → `'Employee number already used by another person'`<br>`'Baris ini gagal disimpan'` → `'This row failed to save'` |
| `packages/core/src/employee/import.ts`<br>2 strings | `'Pratinjau impor tidak ditemukan'` → `'Import preview not found'`<br>`'Pratinjau ini sudah disimpan atau dibatalkan'` → `'This preview has already been saved or cancelled'` |
| `packages/core/src/employee/documents.ts`<br>1 doc-block | Full unsupported-file-type message → `'Unsupported file type. Upload PDF, JPG, PNG, or WebP. Word or Excel files should be converted to PDF first.'` |
| `packages/core/src/employee/employees.ts`<br>1 string | `'Data ini sudah diubah orang lain. Muat ulang sebelum menyimpan.'` → `'This data has been modified by someone else. Reload before saving.'` |
| `packages/core/src/attendance/device-import.ts`<br>1 string | `'Gagal disimpan'` → `'Failed to save'` |

### Priority 3: Database Layer (packages/db/)

No dependencies on modified files.

| File | Indonesian String → English |
|------|---------------------------|
| `packages/db/src/live-events.ts`<br>1 string | `'Terlalu banyak aliran langsung yang aktif'` → `'Too many live streams active'` |

### Priority 4: Email Notifications (packages/core/src/notification/)

No dependencies on modified files.

| File | Lines | Indonesian String → English |
|------|-------|---------------------------|
| `packages/core/src/notification/templates.ts` | Full file | All doc-blocks, email bodies, `remainingText()` function, `formatDate()` month names<br><br>`remainingText()`: `'SUDAH BERAKHIR'` → `'EXPIRED'`, `'berakhir HARI INI'` → `'expires TODAY'`, `'berakhir BESOK'` → `'expires TOMORROW'`, `'berakhir dalam X hari'` → `'expires in X days'`<br><br>`formatDate()`: Januari→January, Februari→February, ... Desember→December<br><br>Email subjects: `'Atur ulang kata sandi'` → `'Password reset'`, `'Undangan bergabung'` → `'Join invitation'`, `'PERLU TINDAKAN:'` → `'ACTION REQUIRED:'`, `'Kontrak ... sudah berakhir'` → `'Contract ... has expired'`<br><br>Consequence text (KITAS/SIM/Sertifikat blocks): Translate all to English<br><br>Notification skip: `'sudah pernah dikirim'` → `'already sent'` |
| `packages/core/src/notification/send.ts`<br>1 string | `'sudah pernah dikirim'` → `'already sent'` |
| `apps/worker/src/leave-notify.ts`<br>2 strings | `'Cuti Anda disetujui'` → `'Your leave has been approved'`<br>`'Cuti Anda ditolak'` → `'Your leave has been rejected'` |

### Priority 5: Auth Server (apps/auth/)

No dependencies on modified files.

| File | Indonesian String → English |
|------|---------------------------|
| `apps/auth/src/server.ts`<br>4 strings | `'Tidak ditemukan'` (×2) → `'Not found'`<br>`'Terlalu banyak permintaan. Coba lagi beberapa saat.'` → `'Too many requests. Try again in a moment.'`<br>`'Terjadi kesalahan pada sistem'` → `'A system error occurred'` |
| `apps/auth/src/routes.ts`<br>4 strings | `'Data login tidak lengkap atau tidak sah'` → `'Login data is incomplete or invalid'`<br>`'Permintaan tidak sah'` → `'Invalid request'`<br>`'Token akses kedaluwarsa'` → `'Access token expired'`<br>`'Token akses tidak sah'` → `'Invalid access token'` |

### Priority 6: Web App Libs (apps/web/src/lib/)

Depends on: None (libs are called by route handlers and components).

| File | Indonesian String → English |
|------|---------------------------|
| `apps/web/src/lib/capture-photo.ts`<br>1 string | `'Gagal mengompresi foto'` → `'Photo compression failed'` |
| `apps/web/src/lib/download.ts`<br>1 string | `` `Unduhan gagal (HTTP ...)` `` → `` `Download failed (HTTP ...)` `` |
| `apps/web/src/lib/define-route.ts`<br>~15 strings | `'Terlalu banyak permintaan. Coba lagi beberapa saat.'` → `'Too many requests. Try again in a moment.'`<br>`'Token akses kedaluwarsa'` → `'Access token expired'`<br>`'Token akses tidak sah'` → `'Invalid access token'`<br>`'Permintaan dari organisasi Anda melebihi ... per menit.'` → `'Your organization\'s requests have exceeded ... per minute.'`<br>`'Coba lagi sebentar lagi.'` → `'Try again shortly.'`<br>`'Hak akses Anda berubah. Token disegarkan otomatis — coba lagi.'` → `'Your access rights have changed. Token refreshed automatically — try again.'`<br>`'Paket langganan Anda belum mencakup modul "'` → `'Your subscription plan does not yet include the module "'`<br>`'Anda tidak memiliki hak akses untuk tindakan ini'` → `'You do not have permission for this action'`<br>`'Terjadi kesalahan pada sistem'` → `'A system error occurred'` |
| `apps/web/src/lib/define-admin-route.ts`<br>4 strings | `'Terlalu banyak permintaan'` → `'Too many requests'`<br>`'Token admin tidak ada'` → `'Admin token not found'`<br>`'Token admin tidak sah'` → `'Invalid admin token'`<br>`'Terjadi kesalahan pada sistem'` → `'A system error occurred'` |
| `apps/web/src/lib/session.tsx`<br>1 string | `'Terjadi kesalahan'` → `'An error occurred'` |
| `apps/web/src/lib/push.ts`<br>3 strings | `'Izin notifikasi ditolak...` → `'Notification permission denied...'`<br>`'Langganan gagal disimpan.'` → `'Subscription failed to save.'`<br>`'Berlangganan notifikasi gagal.'` → `'Notification subscription failed.'` |

### Priority 7: Web App API Routes (apps/web/src/app/api/)

Depends on: `packages/core/auth/` (strings already translated in Priority 1).

| File | Indonesian String → English |
|------|---------------------------|
| `apps/web/src/app/api/auth/login/route.ts`<br>1 string | `'Data login tidak lengkap atau tidak sah'` → `'Login data is incomplete or invalid'` |
| `apps/web/src/app/api/attendance/live/route.ts`<br>1 string | `'Terlalu banyak dasbor langsung terbuka...'` → `'Too many live dashboards open...'` |
| `apps/web/src/app/api/attendance/device-import/route.ts`<br>1 string | `'Permintaan harus berupa multipart/form-data...'` → `'Request must be multipart/form-data containing a file.'` |
| `apps/web/src/app/api/employees/[id]/documents/route.ts`<br>1 string | `'Permintaan harus berupa multipart/form-data.'` → `'Request must be multipart/form-data.'` |

### Priority 8: Worker Scripts (apps/worker/)

No hard dependencies on other modified files, but `leave-notify.ts` is covered in Priority 4 (done first for email template context).

| File | Indonesian String → English |
|------|---------------------------|
| `apps/worker/src/leave-notify.ts` | See Priority 4 |
| `apps/worker/src/pii-rotation.ts`<br>1 string | `'Verifikasi gagal: nilai hasil enkripsi ulang tidak sama dengan aslinya.'` → `'Verification failed: re-encryption result does not match original.'` |
| `apps/worker/src/retry-stuck-outbox.ts`<br>5 strings | `'Tidak ada pesan yang kehabisan percobaan.'` → `'No messages exhausted their retries.'`<br>`'(tanpa galat tercatat)'` → `(no error logged)`<br>`'Perbaiki penyebabnya lebih dulu, lalu ulangi per topik:'` → `'Fix the cause first, then retry per topic:'`<br>`'Tidak ada pesan tertahan...'` → `'No messages stuck on topic ...'`<br>`'pesan dikembalikan ke antrean...'` → `'messages returned to queue. Worker will pump them in the next cycle.'` |

### Priority 9: Web App Pages (apps/web/src/app/)

Depends on: Priority 1-8 (core libs and API routes should be translated first to maintain consistency).

| File | Indonesian String → English |
|------|---------------------------|
| `apps/web/src/app/login/page.tsx`<br>1 string | `'Kata sandi'` → `'Password'` |
| `apps/web/src/app/register/page.tsx`<br>1 string | `'tidak dapat diubah'` → `'cannot be changed'` |
| `apps/web/src/app/admin/page.tsx`<br>~6 strings | `'Modul "${code}" ${enabled ? \'dinyalakan\' : \'dimatikan\'}. Datanya tidak dihapus.'` → `'Module "${code}" ${enabled ? \'enabled\' : \'disabled\'}. Its data is not deleted.'`<br>`'Perubahan modul gagal.'` → `'Module change failed.'`<br>`'Perubahan status gagal.'` → `'Status change failed.'`<br>`'Paket ... · dibuat ...'` → `'Package ... · created ...'` |
| `apps/web/src/app/attendance/records/page.tsx`<br>1 string | `'Ketukan ini sudah pernah dimasukkan...'` → `'This punch has already been recorded...'` |
| `apps/web/src/app/employees/page.tsx`<br>1 string | `', ${failed} gagal...'` → `', ${failed} failed...'` |
| `apps/web/src/app/employees/documents/page.tsx`<br>3 strings | `'Unggahan gagal.'` → `'Upload failed.'`<br>`'Pengarsipan gagal.'` → `'Archiving failed.'`<br>`'Tanggal kedaluwarsa (opsional)'` → `'Expiry date (optional)'` |
| `apps/web/src/app/employees/grid/page.tsx`<br>2 strings | `'Gagal menyimpan'` → `'Save failed'`<br>`'Gagal disimpan'` → `'Failed to save'` |
| `apps/web/src/app/employees/import/page.tsx`<br>1 string | `'Gagal menyimpan'` → `'Save failed'` |
| `apps/web/src/app/leave/me/page.tsx`<br>3 strings | `'Unggahan gagal.'` → `'Upload failed.'`<br>`'Pengajuan gagal.'` → `'Submission failed.'`<br>`'Pembatalan gagal.'` → `'Cancellation failed.'` |
| `apps/web/src/app/leave/approvals/page.tsx`<br>1 string | `'Keputusan gagal disimpan.'` → `'Decision failed to save.'` |
| `apps/web/src/app/leave/policies/page.tsx`<br>1 string | `'Penyesuaian gagal.'` → `'Adjustment failed.'` |
| `apps/web/src/app/payroll/runs/page.tsx`<br>4 strings | `'Run dibuat. Tekan Hitung untuk memprosesnya.'` → `'Run created. Press Calculate to process it.'`<br>`'Run gagal dibuat.'` → `'Run creation failed.'`<br>`'Run disetujui. Slip kini terlihat karyawan.'` → `'Run approved. Payslips are now visible to employees.'` |
| `apps/web/src/app/settings/users/page.tsx`<br>4 strings | `'Undangan dibuat. Emailnya sedang dikirim di latar belakang.'` → `'Invitation created. Email is being sent in the background.'`<br>`'Undangan gagal dibuat.'` → `'Invitation creation failed.'`<br>`'Undangan massal gagal.'` → `'Bulk invitation failed.'`<br>`'Perubahan hak akses gagal.'` → `'Access change failed.'` |
| `apps/web/src/app/settings/roles/page.tsx`<br>2 strings | `'Izin peran ... disimpan...'` → `'Role permissions ... saved.'`<br>`'Penyimpanan gagal.'` → `'Save failed.'` |
| `apps/web/src/app/settings/subscription/page.tsx`<br>2 strings | `'Ekspor gagal.'` → `'Export failed.'`<br>`'Perubahan gagal.'` → `'Change failed.'` |
| `apps/web/src/components/token-password-form.tsx`<br>1 string | `'Tautkan tidak sah atau sudah kedaluwarsa'` → `'Invalid or expired link'` |

## Execution Notes

- Each file should be read in full before editing — Indonesian comments mix doc-blocks and inline comments, and some files have both.
- Error message translations should be **consistent**: `'Gagal ...'` → `'... failed'` or `'Failed to ...'` (pick one form consistently per context).
- `packages/core/auth/login.ts` has `'Kode perusahaan'` which is an Indonesian-specific concept (company code for login). Translate to `'Company code'` but keep the API contract key unchanged.
- Document type codes (`"KTP"`, `"KK"`, `"KITAS"`, `"SIM"` in contracts/ and template subjects) are **proper nouns / Indonesian document category identifiers** — leave these as-is since they are API values and system identifiers, not human-readable text to translate.
- Run `pnpm typecheck` after completion to verify no TypeScript errors.
