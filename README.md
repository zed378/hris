# HRMS — HR Management Suite

Multi-tenant HRIS untuk UKM Indonesia. Monolit modular yang dirancang untuk dapat
dipecah menjadi service bila — dan hanya bila — ada pemicu terukur.

Cetak biru lengkap ada di [`PLAN/`](PLAN/). Yang paling menentukan sehari-hari:
**[`PLAN/12-Rencana-Eksekusi-Tim-Kecil.md`](PLAN/12-Rencana-Eksekusi-Tim-Kecil.md)** —
fase, gerbang, dan alasan setiap keputusan arsitektur.

**Status: Fase 1 (Platform Inti) selesai — backend dan UI shell.**

---

## Menjalankan secara lokal

Prasyarat: Node 24+, pnpm 11+, Docker.

```bash
cp .env.example .env          # kredensial dev sudah terisi
pnpm install
pnpm db:up                    # PostgreSQL 16 di port 5433
pnpm db:migrate
pnpm db:seed

pnpm --filter @hrms/web dev       # API di :3000
pnpm --filter @hrms/worker dev    # pompa outbox
```

**Tenant demo** — `tenantCode: demo`, `owner@demo.test`, `DemoPassword123`.
Paketnya `starter` (**tanpa** payroll) supaya penegakan entitlement terlihat sejak
hari pertama: menu Penggajian tidak dirender dan endpoint-nya menolak 402, meski
TENANT_OWNER memegang seluruh permission.

```bash
curl -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"tenantCode":"demo","email":"owner@demo.test","password":"DemoPassword123"}'
```

**Superuser demo** — `admin@hrms.test`, `AdminPassword123`, TOTP wajib.
`pnpm db:seed` mencetak rahasia TOTP-nya; ubah menjadi kode berjalan dengan:

```bash
pnpm dev:totp <rahasia-base32>
```

## Menjalankan sebagai kontainer

Untuk pengembangan sehari-hari, cara di atas lebih baik — hot reload jauh lebih
cepat daripada membangun ulang image. Tumpukan penuh dipakai saat memeriksa
masalah yang hanya muncul di image, atau saat deploy.

```bash
cp ops/.env.compose.example ops/.env      # ganti kedua JWT secret sebelum produksi
docker compose -f ops/docker-compose.yml --env-file ops/.env up --build
```

Tiga kontainer, dan tidak lebih:

| Kontainer | Peran | Terbuka ke luar |
|---|---|---|
| `postgres` | Data, antrean pekerjaan (pg-boss), kunci terdistribusi (advisory lock) | port 5433 (dev) |
| `web` | **Frontend** — UI dan seluruh REST API (`/api`, `/admin/api`) | port 3000 |
| `worker` | **Backend** — pompa outbox, nanti payroll & impor Excel | tidak sama sekali |

PostgreSQL merangkap tiga peran, dan itu yang membuat tumpukan ini dapat
dioperasikan satu orang: tidak ada RabbitMQ dan tidak ada Redis yang perlu
dijaga hidup (PLAN/12 §3.2).

Layanan `migrate` berjalan sekali sampai selesai sebelum `web` dan `worker`
dimulai, dan ia satu-satunya yang memakai kredensial owner.

## Verifikasi

```bash
pnpm verify        # linter migrasi + lint batas modul + typecheck + test + build
```

> Jangan pakai `pnpm ci` — itu perintah bawaan pnpm (clean install), bukan skrip ini.

---

## Susunan

```
apps/web         Next.js — UI shell dan route handler API bidang tenant (/api)
                 serta control plane (/admin/api)
apps/worker      Proses latar — pompa outbox, pg-boss
packages/core    Modul domain: tenant, iam, auth
packages/db      Prisma, migrasi, konteks tenant, audit, outbox
packages/contracts  Skema Zod: API, token, event
ops/             docker-compose, Dockerfile web & worker, linter migrasi
```

### Empat aturan yang membuat ini bukan sekadar monolit

Keempatnya ditegakkan mesin, bukan kesepakatan. Bersama-sama, keempatnya yang
membuat pemecahan satu modul menjadi service kelak memakan 4–6 minggu, bukan 4–6
bulan (PLAN/12 §9).

1. **Modul hanya berkomunikasi lewat `index.ts`.** Ditegakkan `eslint-plugin-boundaries`.
   Impor ke kedalaman modul lain menggagalkan build.
2. **Event melewati tabel outbox**, bukan panggilan fungsi antar-domain. Bentuk
   kodenya identik dengan versi terdistribusi.
3. **Satu schema PostgreSQL per modul.** Memindahkan modul berarti memindahkan
   schema, bukan membongkar tabel.
4. **Setiap route terdaftar di `ROUTE_MANIFEST`** dengan modul dan permission-nya.
   Route tak terdaftar tidak dapat dijalankan.

---

## Yang perlu diketahui sebelum menulis kode

### Setiap akses data tenant lewat `withTenant()`

```ts
import { withTenant } from '@hrms/db';

await withTenant(tenantId, async (tx) => {
  return tx.user.findMany();   // RLS berlaku penuh
});
```

Tanpa konteks, query mengembalikan **nol baris** — bukan seluruh tabel. Sengaja
gagal-tertutup: kebocoran lintas-tenant tidak melempar galat, ia hanya menampilkan
data orang lain.

Aplikasi berjalan sebagai role `hrms_app` (`NOBYPASSRLS`, bukan pemilik tabel).
Role owner hanya dipakai Prisma CLI saat migrasi.

### Jangan menulis efek samping di transaksi yang berakhir dengan `throw`

`throw` di dalam `withTenant()` mem-*rollback* transaksinya. Efek samping yang
harus bertahan meski request ditolak — penghitung percobaan gagal, kunci akun,
pencabutan token — ditulis di transaksi tersendiri **setelah** yang pertama commit.

Polanya ada di [`packages/core/src/auth/login.ts`](packages/core/src/auth/login.ts):
transaksi mengembalikan *outcome*, pemanggil yang melempar.

Ini bukan kehalusan gaya. Versi pertama melanggarnya, dan hasilnya: sepuluh
percobaan kata sandi salah meninggalkan `failed_login_attempts = 0`. Kunci akun
ada di kode, lulus review, dan tidak melakukan apa pun.

### Token tidak pernah menyentuh penyimpanan yang bertahan

Access token hidup **hanya di memori JavaScript**. Refresh token hidup **hanya
sebagai cookie httpOnly** — tidak dikembalikan di body login, sehingga skrip di
halaman tidak pernah memegangnya (PLAN/11 §5.3).

Konsekuensinya: muat ulang halaman menghilangkan access token, lalu aplikasi
menukar cookie dengan yang baru saat dimuat. Yang dapat dicuri lewat XSS hanya
token berumur 15 menit.

Klien non-browser (skrip, uji) harus ikut memakai cookie jar — `curl -c/-b`.

> `COOKIE_SECURE` sengaja tidak diturunkan dari `NODE_ENV`. `next start`
> menyetel NODE_ENV ke production, sehingga menguji build produksi lewat HTTP
> di mesin sendiri akan selalu mematahkan sesi — browser membuang cookie
> `Secure` pada koneksi polos di setiap hostname kecuali localhost, tanpa satu
> pun galat di sisi server. Defaultnya tetap aman; matikan hanya untuk uji lokal.

### Menu berasal dari basis data, bukan dari kode frontend

Sidebar dirender sepenuhnya dari `/api/me/bootstrap`. Mengaktifkan modul di
control plane langsung mengubah navigasi tenant tanpa deploy.

Karena menu memuat rute Fase 2–5 yang halamannya belum ada, `prefetch`
dimatikan pada tautan menu — tanpa itu, satu kali muat beranda memicu 13
request yang semuanya 404, dan konsol yang penuh akan menenggelamkan error
sungguhan berikutnya. Dilepas kembali ketika halamannya ada.

### Bedakan sesi yang dicabut dari token yang dicuri

Refresh token yang **sudah digantikan** lalu muncul lagi berarti dua pihak
memegang token yang sama — itu indikasi pencurian, dicatat sebagai insiden, dan
seluruh keluarga token dicabut.

Refresh token yang **dicabut** hanya berarti sesinya diakhiri secara sah: logout,
reset kata sandi, atau pembersihan setelah insiden. Keduanya menghasilkan 401 dan
pengguna harus masuk lagi, tetapi hanya yang pertama yang boleh membunyikan alarm.

Versi pertama menyatukan keduanya, dan akibatnya setiap orang yang lupa kata
sandi memicu `auth.token.reuse_detected`. Alarm yang sering salah adalah alarm
yang akan diabaikan saat berbunyi benar.

### Migrasi hanya aditif

Tanpa `DROP`, `RENAME`, atau `TRUNCATE`. Ditegakkan `ops/scripts/lint-migrations.mjs`.
Aturan lengkap dan tangga deprekasi ada di
[`PLAN/09`](PLAN/09-Strategi-Migrasi-Non-Destruktif.md).

RLS ditulis tangan di migrasi — Prisma tidak membangkitkannya. Setiap tabel
ber-`tenant_id` **wajib** punya kebijakan; ada uji CI yang membaca katalog
PostgreSQL dan gagal bila ada yang terlewat.

### Empat principal basis data, masing-masing sesempit mungkin

| Role | Dipakai | Tidak dapat menjangkau |
|---|---|---|
| `hrms_owner` | Prisma CLI saat migrasi | — |
| `hrms_app` | Runtime web, bidang tenant | schema `platform` |
| `hrms_worker` | Proses latar | schema `platform`; RLS berlaku penuh kecuali pada outbox |
| `hrms_platform` | Control plane | `auth.users`, `iam.*`, `audit.*` |

Baris terakhir yang menanggung P11. Bila kelak ada yang menulis pembacaan
`auth.users` di kode control plane, PostgreSQL yang menolaknya — bukan reviewer
yang kebetulan sempat memperhatikan. Hibah ke schema `tenant` diberikan **per
tabel**, bukan menyapu, sehingga modul domain berikutnya tidak akan pernah
terbuka ke control plane tanpa ada yang memutuskannya.

### Empat pengecualian RLS, dan hanya empat

Semuanya berdaftar, berkomentar di migrasinya, dan dihitung uji CI:

| Pengecualian | Alasan |
|---|---|
| `resolve_tenant_by_code` | Jalur login butuh tenantId sebelum konteks dapat dipasang |
| `resolve_refresh_token_owner` | Masalah yang sama pada alur refresh |
| `platform.tenant_user_counts` | Dashboard global butuh angka; SELECT pada `auth.users` akan memberi isinya |
| Kebijakan `outbox_publisher` | Pompa event adalah infrastruktur; hanya role `hrms_worker`, hanya satu tabel |

Uji `rls-coverage.test.ts` gagal saat pengecualian berikutnya muncul — memaksa
penambahnya menjelaskan alasannya di PR, bukan menyelipkannya.

### Dua bidang, dua guard, tidak pernah bercampur

`defineRoute` untuk `/api/**`, `defineAdminRoute` untuk `/admin/api/**`. Sengaja
dua fungsi terpisah, bukan satu dengan parameter `isAdmin`: sejak ada parameter
semacam itu, satu kekeliruan boolean memisahkan metadata seluruh pelanggan dari
orang yang tidak berhak.

Uji CI memeriksa keduanya ke dua arah — handler admin yang memakai guard tenant
(atau sebaliknya) menggagalkan build.

> Catatan Next.js: folder route admin **tidak boleh** diawali garis bawah.
> `_admin` adalah *private folder* yang dikeluarkan dari routing, dan gejalanya
> hanyalah route yang diam-diam tidak ada di keluaran build.

---

## Yang sudah berjalan

- Multi-tenancy dengan RLS gagal-tertutup, terverifikasi uji lintas-tenant
- Login `tenantCode + email + password`, argon2id, kunci akun setelah 8 percobaan
- Refresh token dengan rotasi dan **pencabutan seluruh keluarga** saat pemakaian ulang terdeteksi
- Peran, permission, menu, grant/deny per pengguna, resolusi akses efektif
- Entitlement modul: permission dari modul tak dilanggan gugur otomatis (402, bukan 403)
- `/api/me/bootstrap` — sumber tunggal sidebar dan penjagaan rute
- Jejak audit append-only (trigger + hak akses)
- Outbox transaksional + pompa ke pg-boss
- Pendaftaran tenant mandiri — satu transaksi ACID, tanpa saga dan tanpa kompensasi
- Control plane `/admin/api`: login superuser (kata sandi + TOTP), daftar tenant,
  ringkasan platform, aktivasi/penonaktifan modul, jejak audit terpisah
- Undangan pengguna & reset kata sandi lewat token sekali pakai; reset mencabut
  seluruh sesi berjalan
- Pengelolaan peran dan hak akses khusus per pengguna — versi akses naik di
  transaksi yang sama, sehingga pencabutan berlaku seketika
- UI shell: halaman masuk, sidebar dinamis dari bootstrap, penjagaan rute,
  halaman modul terkunci — sesi bertahan lintas muat ulang tanpa token pernah
  disimpan JavaScript

## Yang belum

Modul karyawan/presensi/cuti/payroll (Fase 2+), pengiriman email sungguhan
(event `auth.password.reset_requested` dan `iam.user.invited` sudah terbit ke
outbox, konsumernya belum ada), support session (PLAN/07 §6).

Sampai support session dibangun, jawaban atas "bagaimana tim dukungan melihat
data pelanggan?" adalah **tidak bisa** — bukan pintu belakang sementara.

Urutan dan gerbangnya di [`PLAN/12`](PLAN/12-Rencana-Eksekusi-Tim-Kecil.md) §6.
