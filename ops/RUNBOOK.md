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

## Yang belum ada di runbook ini

Ditulis terus terang supaya tidak dicari saat dibutuhkan:

- **Pemulihan dari cadangan** — prosedurnya belum diuji, jadi belum ditulis.
  Menulis prosedur pemulihan yang belum pernah dijalankan lebih berbahaya
  daripada tidak menulisnya: ia memberi rasa aman yang tidak berdasar.
- **Insiden penagihan** — modulnya belum ada.
- **Kegagalan payment gateway** — belum terintegrasi.
