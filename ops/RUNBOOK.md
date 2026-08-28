# Runbook Insiden

Lima insiden yang paling mungkin terjadi, beserta cara mengenali dan
menanganinya. Ditulis untuk dibaca pada pukul dua pagi oleh orang yang tidak
menulis kodenya.

Aturan yang berlaku pada seluruh prosedur di bawah:

- **Jangan menghapus data untuk memulihkan layanan.** Aturan M4 dokumen `09`.
  Hampir setiap insiden di sini punya jalan keluar yang tidak menghapus apa pun.
- **Jangan memberi `BYPASSRLS` kepada peran aplikasi**, bahkan sementara. Job
  drift harian akan menemukannya, tetapi di antara dua pemeriksaan itu seluruh
  isolasi tenant berhenti berlaku.
- **Catat apa yang Anda lakukan** di kanal insiden sambil melakukannya, bukan
  sesudahnya. Yang menyelesaikan insiden biasanya bukan yang menulis laporannya.

---

## 1. Aplikasi lambat atau menggantung

**Gejala.** Halaman lama dimuat. Log memuat `{"scope":"overload"}` atau balasan
503. Pengguna melaporkan "sistem lemot", bukan galat.

**Periksa lebih dulu, sebelum apa pun:**

```bash
curl -s -o /dev/null -w '%{http_code}
' http://<host>/api/health   # proses hidup?
curl -s http://<host>/api/ready                                     # basis data terjangkau?
```

`health` 200 tetapi `ready` 503 berarti aplikasinya hidup dan basis datanya
yang bermasalah — dan pada keadaan itu **jangan merestart aplikasi**. Restart
tidak memperbaiki basis data, dan setiap instance yang menyala kembali langsung
membuka pool koneksi baru ke basis data yang sudah kewalahan.

**Penyebab paling sering.** Pool transaksi habis — biasanya satu tenant
menjalankan impor besar, atau satu query menyapu tabel tanpa indeks.

**Diagnosis.**

```sql
-- Query yang sedang berjalan, terlama dahulu.
SELECT pid, usename, state, now() - query_start AS lama, left(query, 120)
FROM pg_stat_activity
WHERE state <> 'idle' AND query NOT LIKE '%pg_stat_activity%'
ORDER BY query_start;

-- Transaksi menganggur yang menahan lock.
SELECT pid, usename, now() - state_change AS menganggur, left(query, 80)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change;
```

**Tindakan.**

1. `statement_timeout` peran `hrms_app` adalah 15 detik, sehingga query pengguna
   memotong dirinya sendiri. Query yang berjalan lebih lama hampir pasti milik
   `hrms_worker` (batas 5 menit) atau `hrms_owner` (tanpa batas).
2. Bila satu query jelas menjadi penyebabnya, hentikan **query**-nya saja:
   `SELECT pg_cancel_backend(<pid>)`. Pakai `pg_terminate_backend` hanya bila
   `pg_cancel_backend` tidak berhasil — ia memutus koneksinya, dan transaksi
   yang sedang berjalan di-rollback.
3. Bila penyebabnya satu tenant yang membanjiri, kuotanya (600 permintaan per
   menit) sudah menahan sebagian. Log `{"scope":"tenant-quota"}` menyebut
   `tenantId`-nya.
4. Setelah pulih: cari query yang lambat itu di log dan **tambahkan indeksnya**.
   Insiden yang sama akan berulang pada hari kerja berikutnya.

---

## 2. Job latar berhenti — presensi bertanda tidak sampai, email tidak terkirim

**Gejala.** Log worker memuat `{"scope":"outbox","stuck":N}` dengan N naik, atau
worker sama sekali tidak mengeluarkan log.

**Diagnosis.**

```bash
pnpm --filter @hrms/worker outbox:retry     # menampilkan yang tertahan, tanpa mengubah apa pun
```

```sql
SELECT topic, count(*), min(last_error)
FROM messaging.outbox_messages
WHERE published_at IS NULL AND attempts >= 10
GROUP BY topic;
```

**Tindakan.**

1. Baca `last_error`. Penyebab yang pernah terjadi: **antrean pg-boss belum
   dibuat** untuk sebuah topik. Itu berarti topiknya tidak ada di katalog
   `EventTopic` — sekarang mustahil karena tipenya, tetapi periksa tetap.
2. Perbaiki penyebabnya lebih dulu. Mengembalikan pesan ke antrean sebelum
   penyebabnya hilang hanya menghabiskan sepuluh percobaan lagi.
3. Setelah penyebabnya hilang:
   `pnpm --filter @hrms/worker outbox:retry <topik>`
4. **Jangan menghapus baris outbox.** Pesan yang hilang berarti presensi yang
   tidak pernah ditinjau atau email yang tidak pernah terkirim, tanpa jejak.

---

## 3. Isolasi tenant bocor

**Gejala.** Seseorang melaporkan melihat data yang bukan miliknya. Atau job
drift harian melaporkan `{"scope":"schema-drift","severity":"critical"}`.

**Ini insiden paling berat dalam daftar ini.** Perlakukan sebagai kebocoran data.

**Diagnosis.**

```sql
SELECT * FROM public.schema_drift_report();
```

Tiga temuan yang mungkin muncul:

| `kind` | Artinya | Akibat |
|---|---|---|
| `rls_missing` | Tabel ber-`tenant_id` tanpa RLS | **Setiap tenant membaca data seluruh tenant lain** |
| `policy_missing` | RLS aktif tanpa kebijakan | Tabelnya menolak semua — modul mati total |
| `bypass_rls` | Peran aplikasi dapat menembus RLS | Seluruh isolasi berhenti berlaku |

**Tindakan.**

1. Untuk `bypass_rls`, segera: `ALTER ROLE hrms_app NOBYPASSRLS;`
2. Untuk `rls_missing`, pasang kebijakannya dengan pola yang sama seperti tabel
   lain — lihat migrasi mana pun yang membuat tabel bertenant.
3. Jangan berhenti di perbaikan. **Cari tahu bagaimana tabel itu bisa ada tanpa
   RLS**: hampir pasti ia dibuat lewat psql di luar migrasi, atau sebuah migrasi
   gagal separuh jalan.
4. Tentukan cakupan kebocorannya dari `audit.audit_logs` dan log akses. UU PDP
   No. 27/2022 mewajibkan pemberitahuan kepada subjek data.

---

## 4. Migrasi gagal separuh jalan

**Gejala.** `prisma migrate deploy` gagal dengan `P3009`, dan penerapan
berikutnya menolak berjalan.

**Tindakan.**

1. Baca galat aslinya:
   `pnpm --filter @hrms/db exec prisma migrate deploy` — pesannya menyebut
   migrasi mana yang gagal dan pada pernyataan apa.
2. Periksa apa yang SUDAH terlanjur diterapkan. Migrasi bukan atomik bila memuat
   `CREATE INDEX CONCURRENTLY` atau beberapa pernyataan DDL.
3. Perbaiki berkas migrasinya, lalu:
   ```bash
   pnpm --filter @hrms/db exec prisma migrate resolve --rolled-back <nama_migrasi>
   pnpm --filter @hrms/db exec prisma migrate deploy
   ```
4. **Jangan pakai `--applied`** untuk melewatinya, kecuali Anda sudah memastikan
   seluruh isi migrasi itu memang sudah ada di basis data. Menandainya
   "diterapkan" padahal belum akan membuat migrasi berikutnya gagal dengan cara
   yang jauh lebih membingungkan.
5. Ingat aturan P12: migrasi hanya aditif. Bila perbaikannya menuntut `DROP`,
   perbaikannya salah.

---

## 5. Foto presensi tidak terhapus setelah masa retensi

**Gejala.** Log memuat `{"scope":"photo-retention","failed":N}`, atau berkas
menumpuk di `.storage/attendance-photos`.

**Mengapa ini insiden.** UU PDP No. 27/2022 mensyaratkan data pribadi tidak
disimpan lebih lama dari keperluannya. Foto wajah yang bertahan melewati 90 hari
adalah pelanggaran yang berjalan, bukan kerapian penyimpanan.

**Diagnosis.**

```sql
SELECT count(*) FROM attendance.punch_logs
WHERE photo_key IS NOT NULL AND photo_expires_at < now();
```

**Tindakan.**

1. Baca galat pada log. Yang paling mungkin: izin berkas, disk penuh, atau
   `PHOTO_STORAGE_DIR` menunjuk tempat yang salah.
2. Periksa akar penyimpanannya benar-benar sama untuk `apps/web` dan
   `apps/worker`. Path relatif diselesaikan terhadap akar repositori, bukan
   direktori kerja proses — bila `PHOTO_STORAGE_DIR` diisi path relatif pada
   salah satunya saja, keduanya menunjuk tempat berbeda.
3. Rujukan basis data **sengaja tidak dihapus** ketika penghapusan berkas gagal.
   Selama ia bertahan, putaran berikutnya akan menemukan berkas itu lagi.
4. Setelah penyebabnya hilang, job berjalan sendiri pada putaran berikutnya —
   tidak ada yang perlu dijalankan manual.

---

## 6. Pemulihan dari cadangan

**Prosedur ini sudah dijalankan dan diverifikasi**, bukan disusun dari dokumentasi.
Hasil uji terakhir dicatat di bawah.

### Mencadangkan

```bash
bash ops/scripts/backup.sh ./backups
```

Skrip memverifikasi isinya, bukan hanya keberadaan berkasnya — cadangan yang
gagal separuh jalan tetap meninggalkan berkas, dan yang membedakannya dari
cadangan yang dapat dipakai adalah apakah daftar isinya dapat dibaca.

Menghasilkan **dua** berkas dengan stempel waktu yang sama:

| Berkas | Isi |
|---|---|
| `hrms-<stamp>.dump` | Basis data |
| `hrms-<stamp>-storage.tar.gz` | Foto presensi dan dokumen karyawan |

Keduanya harus dipulihkan sebagai pasangan. Cadangan basis data tanpa berkasnya
akan terlihat lengkap — seluruh tabel ada, seluruh baris ada, dan
`punch_logs.photo_key` menunjuk berkas yang sudah tidak ada. Kegagalannya baru
terlihat saat seseorang membuka foto presensi untuk menyelesaikan sengketa upah.

Retensi 14 cadangan terakhir, dihitung per **jumlah** bukan umur: retensi
berbasis umur akan menghapus semuanya sekaligus bila job-nya berhenti dua pekan
lalu berjalan lagi. Arsip berkas ikut terhapus bersama dump pasangannya.

### Memulihkan

**Selalu pulihkan ke basis data BARU lebih dulu**, bukan langsung menimpa
produksi. Memulihkan cadangan lama ke atas basis data yang masih baik adalah
satu-satunya hal yang lebih buruk daripada tidak punya cadangan.

```bash
bash ops/scripts/restore.sh backups/hrms-20260828T090736Z.dump hrms_restore
```

Skrip menuntut konfirmasi berupa **nama basis datanya**, bukan sekadar "y".

Berkas penyimpanan dipulihkan terpisah, dari arsip berstempel waktu SAMA:

```bash
tar -xzf backups/hrms-20260828T090736Z-storage.tar.gz -C /path/tujuan
```

**Diuji ujung-ke-ujung:** berkas hasil ekstraksi identik sampai hash SHA-256,
struktur direktorinya utuh, dan `storage_key` pada `employee_documents` resolve
ke path yang benar. Arsip yang belum pernah dibuka bukan cadangan.

### Menjadwalkan cadangan

Dua cara. Pilih satu — menjalankan keduanya menghasilkan dua rangkaian cadangan
yang retensinya saling tidak tahu, dan salah satunya akan menghapus berkas yang
dianggap milik yang lain.

#### A. Layanan compose — untuk deployment satu VPS

```bash
docker compose --profile backup up -d
```

Berada di balik profil, sehingga tidak ikut menyala pada `docker compose up`
biasa. **Tidak memasang socket Docker**: memasang `/var/run/docker.sock`
memberi kontainer kendali penuh atas mesin — setara root di host — dan
menukarnya demi kenyamanan penjadwalan adalah pertukaran yang buruk. Layanan ini
memakai `pg_dump` di dalam image PostgreSQL dan terhubung lewat jaringan seperti
klien biasa.

| Variabel | Bawaan | Arti |
|---|---|---|
| `BACKUP_INTERVAL_SECONDS` | 86400 | Jarak antar-cadangan — **ini RPO nyata Anda**, karena belum ada PITR |
| `BACKUP_KEEP` | 14 | Berapa cadangan disimpan |

**Batasnya:** penjadwalnya gelung tidur, bukan cron, karena cron di dalam
kontainer menuntut proses init tersendiri dan wadah berproses ganda membuat
`docker logs` serta sinyal berhenti berperilaku aneh. Konsekuensinya, jadwalnya
**bergeser**: bila cadangan memakan lima menit, yang berikutnya mundur lima
menit, dan setelah sebulan waktunya sudah jauh dari yang dimaksud.

Untuk penjadwalan yang harus tepat waktu, pakai cara B.

#### B. Cron di host — untuk jadwal yang harus tepat

```cron
# Setiap hari pukul 02:15 waktu setempat.
15 2 * * * cd /opt/hrms && bash ops/scripts/backup.sh /var/backups/hrms >> /var/log/hrms-backup.log 2>&1
```

`backup.sh` memilih modenya sendiri: `pg_dump` langsung bila klien PostgreSQL
ada di PATH dan `PGHOST`/`DATABASE_URL` terisi, `docker exec` bila tidak.
Modenya dicetak di baris pertama keluaran — skrip cadangan yang diam-diam
berpindah mode adalah skrip yang berhasil di laptop dan gagal di server.

**Cadangan yang tidak pernah diperiksa bukan cadangan.** Jadwalkan pemulihan uji
ke basis data terpisah sekurangnya sebulan sekali; prosedurnya di bawah, dan
pada ukuran 160 MB ia selesai dalam lima detik.

### Yang WAJIB diperiksa setelah pemulihan

Data yang pulih tanpa RLS bukan pemulihan yang berhasil — ia kebocoran yang
menunggu permintaan pertama. Skripnya memeriksa ini otomatis, tetapi periksa
sendiri sebelum mengarahkan aplikasi ke sana:

```sql
-- 1. Nol temuan drift.
SELECT * FROM public.schema_drift_report();

-- 2. Jumlah kebijakan sama dengan basis data asal.
SELECT count(*) FROM pg_policies
WHERE schemaname NOT IN ('pg_catalog','information_schema');

-- 3. Isolasi benar-benar bekerja. Dijalankan sebagai hrms_app, BUKAN owner —
--    owner menembus RLS, sehingga mengujinya sebagai owner tidak menguji apa pun.
SET ROLE hrms_app;
SELECT count(*) FROM employee.employees;                      -- harus 0
SELECT set_config('app.tenant_id', '<uuid-tenant>', false);
SELECT count(*) FROM employee.employees;                      -- harus sesuai
```

Bila drift tidak nol, jalankan migrasi terhadap basis data hasil pulih sebelum
memakainya:

```bash
DATABASE_URL=<url-ke-basis-data-pulih> pnpm --filter @hrms/db exec prisma migrate deploy
```

Migrasi bersifat idempoten dan aditif; ia hanya melengkapi yang belum ada.

### Hasil uji — 28 Agustus 2026

Dua uji: satu pada data pengembangan, satu pada data seukuran tenant menengah.

#### Pada ukuran nyata — 500 karyawan, satu tahun presensi

| | |
|---|---|
| Basis data | 160 MB — 261.000 ketukan, 130.500 rekap harian, 500 karyawan |
| **Waktu cadangan** | **2 detik** → dump 11 MB (terkompresi dari 160 MB) |
| **Waktu pemulihan** | **5 detik**, termasuk membuat ulang basis data dan memeriksa drift |
| Kelengkapan | 261.000 / 130.500 / 500 — identik baris demi baris |
| Kebijakan RLS | 47 pada asal, 47 pada hasil pulih |
| Laporan drift | 0 temuan |

Angka ini yang menentukan target pemulihan: **pemulihan penuh tenant berukuran
500 karyawan selesai di bawah sepuluh detik**, sehingga jendela pemadaman pada
insiden pemulihan ditentukan oleh keputusan manusia, bukan oleh mesin.

Ekstrapolasi kasar untuk tenant lebih besar: waktunya hampir linear terhadap
jumlah baris. 5.000 karyawan dengan riwayat yang sama ≈ 1,6 GB, dan pemulihannya
di kisaran satu menit — masih jauh di bawah ambang yang menuntut PITR.

#### Pada data pengembangan

| Yang diperiksa | Hasil |
|---|---|
| Ukuran cadangan | 272 KB, 62 tabel berisi data |
| Jumlah baris per tabel | Identik: audit 272, punch 32, cuti 6, slip 3, jejak hitung 15, karyawan 3, tenant 2 |
| Kebijakan RLS | 47 pada asal, 47 pada hasil pulih |
| Laporan drift | 0 temuan |
| Isolasi tanpa konteks tenant | 0 baris terbaca — fail-closed |
| Isolasi dengan konteks demo | 3 karyawan, 32 punch — sesuai |
| Isolasi dengan konteks tenant lain | 0 karyawan, 0 punch, 0 slip |

### Batasnya, dinyatakan terus terang

- **Belum ada PITR.** Yang ada cadangan berkala, sehingga kehilangan data
  maksimum adalah `BACKUP_INTERVAL_SECONDS` — bawaannya 24 jam. PITR menuntut
  WAL archiving yang belum dikonfigurasi.
- **Jadwal layanan compose bergeser.** Lihat catatan pada cara A di atas.
- **Belum diuji di atas 160 MB.** Angka di atas linear pada rentang yang diuji,
  tetapi ekstrapolasi bukan pengukuran. Tenant pertama yang melewati satu
  gigabita layak diukur ulang.
- **Berkas penyimpanan pada uji skala hanya satu berkas.** Waktu pengarsipan
  puluhan ribu foto presensi belum diukur, dan `tar` atas banyak berkas kecil
  berperilaku berbeda dari `tar` atas satu berkas besar.

---

## Yang belum ada di runbook ini

Ditulis terus terang supaya tidak dicari saat dibutuhkan:

- **Insiden penagihan** — modulnya belum ada.
- **Kegagalan payment gateway** — belum terintegrasi.
- **Cadangan berkas penyimpanan** — lihat batasnya di §6.
