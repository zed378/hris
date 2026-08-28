# 00 — Analisis Sistem Referensi & Ruang Lingkup Produk

**Sumber referensi:** https://casadigital.id/hrscientist-hrmanagement/
**Nama produk referensi:** HRIS Scientist — HR Management (berbasis Excel)
**Tanggal analisis:** 17 Agustus 2026

---

## 1. Ringkasan Sistem Referensi

Produk referensi adalah **HRIS berbasis Excel workbook** yang dijual sebagai produk digital sekali beli (one-time purchase) melalui platform checkout pihak ketiga (lynk.id). Nilai jual utamanya bukan kecanggihan teknologi, melainkan:

1. **Zero learning curve** — pengguna tetap bekerja di Excel, tidak perlu belajar software baru.
2. **Konsolidasi data** — menggantikan banyak file tersebar menjadi satu workbook dengan satu dashboard.
3. **Harga rendah** — Rp 99.000 – Rp 199.000 (diskon 50–80% dari harga coret).
4. **Cakupan end-to-end** — administrasi HR dari absensi sampai appraisal.

### 1.1 Inventaris Fitur (hasil ekstraksi halaman)

| # | Fitur | Deskripsi pada referensi | Paket |
|---|-------|--------------------------|-------|
| 1 | Daily Presence | Pantau kehadiran karyawan setiap hari | Basic |
| 2 | Kalender Cuti | Kelola jadwal cuti, izin, sisa hak cuti | Basic |
| 3 | Employee Performance | Penilaian kinerja terstruktur | Basic |
| 4 | Wages & Salary | Pengelolaan penggajian | Basic |
| 5 | RACI Matrix | Matriks tanggung jawab peran | Advanced |
| 6 | DACI Matrix | Matriks pengambilan keputusan | Advanced |
| 7 | Internal Relation | Employee database + employee issues | Advanced |
| 8 | FTE Table | Analisis beban kerja / Full-Time Equivalent | Ultimate |
| 9 | Employee Recruitment | Rekrutmen end-to-end | Ultimate |
| 10 | Employee Development Plan | Rencana pengembangan karyawan | Ultimate |

### 1.2 Struktur Komersial (Tiering)

| Paket | Harga normal | Harga jual | Jumlah modul |
|-------|--------------|------------|--------------|
| Basic | Rp 199.000 | Rp 99.000 | 4 |
| Advanced | Rp 596.000 | Rp 149.000 | 7 |
| Ultimate | Rp 745.000 | Rp 199.000 | 10 |

**Temuan arsitektural paling penting:** struktur komersial referensi **sudah modular secara natural**. Setiap fitur adalah sheet/kumpulan sheet yang dapat dilepas-pasang, dan paket = bundel modul. Ini adalah justifikasi bisnis langsung untuk arsitektur **plug-and-play/add-ons** pada versi aplikasi web — kita tidak memaksakan modularitas, kita hanya memindahkan model bisnis yang sudah ada ke arsitektur perangkat lunak yang tepat.

---

## 2. Analisis Kesenjangan (Gap Analysis): Excel → Aplikasi Web

| Dimensi | Kondisi pada referensi (Excel) | Konsekuensi | Solusi pada cetak biru |
|---------|-------------------------------|-------------|------------------------|
| **Konkurensi** | Satu file, satu penulis efektif. Multi-user via shared drive menimbulkan konflik versi (`file_final_v2_revisi.xlsx`) | Data loss, race condition manual | PostgreSQL + transaksi ACID, optimistic locking, advisory lock (dok. 03) |
| **Integritas data** | Tidak ada foreign key; NIK bisa typo, cuti bisa minus | Payroll salah hitung | Constraint FK, `CHECK`, unique partial index, state machine (dok. 02) |
| **Audit trail** | Tidak ada. Siapa mengubah gaji siapa tidak terlacak | Risiko fraud & sengketa ketenagakerjaan | Tabel `audit_logs` append-only + trigger (dok. 02) |
| **Real-time** | Manual refresh, kirim ulang file | Dashboard manajemen selalu basi | WebSocket fanout via Redis Pub/Sub (dok. 03) |
| **Beban kerja berat** | Payroll 1.000 karyawan membekukan Excel | Tidak scalable | Message Queue + worker asinkron (dok. 03) |
| **Keamanan** | Password sheet Excel mudah dibobol; semua orang melihat semua gaji | Kebocoran data pribadi (UU PDP No. 27/2022) | RBAC/ABAC, Row-Level Security, enkripsi kolom sensitif |
| **Kepatuhan** | Rumus PPh21/BPJS di-hardcode di sel; berubah tiap regulasi | Salah potong pajak | Tabel konfigurasi komponen payroll + rule engine berversi |
| **Integrasi** | Tidak ada API; mesin fingerprint diinput manual | Human error absensi | Konektor mesin absensi, REST/Webhook API |
| **Skala** | Praktis mentok ±200 karyawan | Tidak bisa naik segmen | Partisi tabel, index, horizontal scaling |

### 2.1 Yang Harus **Dipertahankan** dari Referensi

Kesalahan umum saat "meng-upgrade" produk Excel adalah membuang keunggulannya. Tiga hal wajib dipertahankan:

1. **Familiaritas grid** — UI utama untuk entri massal harus berupa **spreadsheet-like grid** (bisa paste dari Excel, keyboard navigation, bulk edit), bukan form satu-per-satu.
2. **Impor/ekspor Excel sebagai warga kelas satu** — setiap modul wajib punya template `.xlsx` untuk impor dan ekspor. Ini juga jalur migrasi bagi pelanggan eksisting produk referensi.
3. **Time-to-value pendek** — pengguna harus bisa melihat dashboard berisi data dalam < 30 menit sejak registrasi (via wizard impor Excel).

---

## 3. Positioning Produk Target

**Nama kerja:** *HR Management Suite (HRMS)*
**Model:** Multi-tenant SaaS B2B, langganan bulanan/tahunan, dengan **katalog add-on** yang dapat diaktifkan per tenant.
**Target segmen:** UKM–menengah Indonesia, 20–2.000 karyawan (segmen yang saat ini membeli produk Excel referensi, plus segmen di atasnya yang sudah tidak muat di Excel).

### 3.1 Pemetaan Modul Referensi → Service

Setiap fitur referensi menjadi service mandiri dengan basis data sendiri. Modul yang terlalu kecil untuk berdiri sendiri digabung berdasarkan kesamaan konsep, bukan dipecah demi kerapian.

```
SERVICE PLATFORM (selalu aktif, tidak terkait langganan)
├── api-gateway          titik masuk tunggal, validasi X-Tenant-ID, entitlement, permission
├── auth-service         login (tenantCode + email + password), JWT, sesi
├── iam-service          peran, permission, menu, hak akses per pengguna
├── tenant-service       tenant, paket langganan, aktivasi modul
├── notification-service email, push, WhatsApp
├── file-service         unggah/unduh, presigned URL
├── realtime-service     gateway WebSocket
└── reporting-service    read model lintas domain (CQRS)

SERVICE DOMAIN — TIER 1 (setara Paket Basic)
├── employee-service     → Internal Relation (employee database) — modul inti, selalu aktif
├── attendance-service   → Daily Presence
├── leave-service        → Kalender Cuti
├── performance-service  → Employee Performance
└── payroll-service      → Wages & Salary

SERVICE DOMAIN — TIER 2 (setara Paket Advanced)
├── planning-service     → RACI Matrix + DACI Matrix
└── relation-service     → Internal Relation (employee issues, SP, grievance)

SERVICE DOMAIN — TIER 3 (setara Paket Ultimate)
├── recruitment-service  → Employee Recruitment (ATS end-to-end)
└── planning-service     → FTE Table + Employee Development Plan (modul tambahan pada service yang sama)

EKSTENSI (di luar cakupan referensi, peluang monetisasi baru)
├── ESS Mobile           Employee Self Service
├── device-bridge        Integrasi mesin fingerprint/face recognition
├── e-signature          Tanda tangan digital kontrak
└── analytics-plus       Prediksi turnover, cost-to-hire

MODUL EKSPANSI USULAN (rincian & prioritas di dokumen 08)
├── contract-compliance  Pengingat berakhirnya PKWT, sertifikat, izin      [Basic, prioritas 1]
├── claim                Reimbursement, SPPD, kasbon/pinjaman karyawan     [Advanced, prioritas 2 & 4]
├── onboarding           Onboarding & offboarding lintas departemen        [Advanced, prioritas 3]
├── hse                  K3: insiden, HIRADC, inspeksi, sertifikasi        [Add-on industri, prioritas 5]
├── asset                Aset & inventaris, serah terima, clearance        [Advanced]
├── training             Riwayat pelatihan & masa berlaku sertifikat       [Ultimate]
├── helpdesk             Ticketing pertanyaan karyawan                     [Advanced]
├── engagement           Pulse survey, eNPS                                [Ultimate]
├── roster-planning      Penjadwalan shift lanjutan                        [Add-on industri]
└── multi-entity         Grup perusahaan dengan beberapa badan hukum       [Add-on industri]
```

**Sinyal distribusi yang perlu dicatat:** tautan checkout Paket Basic pada halaman referensi mengarah ke `lynk.id/komunitashse`, sedangkan paket lain ke `lynk.id/hrscientist`. Penjual memiliki akses ke komunitas praktisi K3/HSE — audiens yang sudah terkumpul dan sudah terbukti membeli. Ini menjadikan modul `hse` sebagai kandidat dengan biaya akuisisi pelanggan terendah di antara seluruh usulan (analisis lengkap di dokumen `08`, §1.2).

**Catatan pembagian:** RACI/DACI, FTE Table, dan Development Plan ditempatkan pada satu `planning-service` karena ketiganya berbagi konsep yang sama (aktivitas, peran, target) dan tidak ada satu pun yang cukup besar untuk berdiri sendiri. Memecahnya menjadi tiga service hanya menambah biaya operasi tanpa manfaat. Sebaliknya, `attendance-service` dan `payroll-service` berdiri sendiri karena profil bebannya berbeda dua orde magnitudo dari service lain dan keduanya perlu diskalakan secara independen.

**Modul ≠ service.** Satu service dapat menyediakan beberapa modul berlangganan (`planning-service` menyediakan `raci-daci`, `workforce-planning`, dan `development`). Entitlement dievaluasi per modul di gateway, bukan per service.

### 3.2 Prinsip Desain yang Mengikat Seluruh Cetak Biru

| Prinsip | Implikasi teknis |
|---------|------------------|
| **P1. Service platform tipis, service domain tebal** | Service platform (auth, iam, tenant) tidak boleh mengetahui logika HR. Ketergantungan hanya satu arah: domain → platform. |
| **P2. Komunikasi antar-service lewat event, bukan panggilan langsung** | `payroll-service` tidak memanggil `attendance-service` untuk mengetahui perubahan; ia berlangganan event `attendance.period.closed`. gRPC sinkron hanya untuk empat jalur yang tidak dapat ditunda. |
| **P3. Modul dapat dinonaktifkan tanpa merusak sistem** | Setiap konsumen event harus toleran terhadap event yang tidak pernah datang (graceful degradation). |
| **P4. Semua operasi berat itu asinkron** | Payroll run, impor Excel, generate slip gaji PDF, rekap absensi → antrean, bukan HTTP request-response. |
| **P5. Setiap perubahan data finansial/personal teraudit** | Tidak ada `UPDATE` diam-diam pada tabel payroll/employee tanpa jejak. |
| **P6. Tenant terisolasi secara default** | Row-Level Security aktif di level basis data setiap service, bukan hanya di level aplikasi. |
| **P7. Tidak ada route gateway tanpa keputusan otorisasi eksplisit** | Setiap route wajib terdaftar di `ROUTE_MANIFEST` dengan modul dan permission-nya; route tak terdaftar mengembalikan 404. |
| **P8. Langganan mengalahkan peran** | Izin dari modul yang tidak dilanggan tenant otomatis gugur saat resolusi, tanpa perlu mencabut peran. |
| **P9. Frontend menyembunyikan, backend menolak** | Menu yang tidak dirender hanyalah kenyamanan; setiap kontrol UI punya pasangannya di gateway. Bila keduanya berbeda, gateway yang benar. |
| **P10. Tidak ada service yang menyentuh basis data service lain** | Ditegakkan hak akses PostgreSQL, bukan kesepakatan. Pelanggarannya mengubah microservices menjadi monolit terdistribusi. |
| **P11. Superuser tidak pernah mem-bypass RLS** | Control plane terpisah dari tenant plane. Akses superuser ke data tenant hanya lewat support session yang disetujui tenant, melalui gateway yang sama dengan pengguna biasa. Tidak ada pintu belakang. |
| **P12. Migrasi selalu aditif** | `ADD`, tidak pernah `DROP` atau `RENAME`. Skema harus kompatibel dengan versi aplikasi sebelumnya, sehingga rollback aplikasi selalu aman. Penghapusan kolom hanya lewat tangga deprekasi berjenjang dengan arsip. |
| **P13. Riwayat tidak pernah ditimpa** | Data berdimensi waktu (tarif pajak, struktur gaji, kebijakan cuti) ditutup periodenya dan dilanjutkan baris baru — tidak pernah di-`UPDATE` di tempat. Slip gaji tahun lalu tidak boleh berubah karena regulasi tahun ini. |
| **P14. Bukti presensi dinilai, bukan dipercaya** | Koordinat dan foto adalah klaim perangkat yang dapat dipalsukan. Sistem memberi skor kepercayaan dan menandai anomali untuk ditinjau manusia — bukan menerima atau menolak secara otomatis berdasarkan satu sinyal. |
| **P15. Pembatasan tujuan pada data lokasi** | Lokasi diambil hanya pada saat presensi, tidak pernah di latar belakang, dan tidak diteruskan ke `reporting-service` sebagai koordinat mentah. Ini yang membedakan alat presensi dari alat pengawasan. |
| **P16. Luring untuk baca data sendiri, bukan untuk segalanya** | Cache diberikan pada data pribadi pengguna; data gaji, dashboard agregat, dan kasus rahasia tidak pernah disimpan di perangkat. Satu-satunya tulis luring adalah presensi, karena hanya itu yang benar-benar terhalang jaringan. |

---

## 4. Kebutuhan Non-Fungsional (Target Terukur)

| Kategori | Target |
|----------|--------|
| Ketersediaan | 99,5% bulanan (MVP) → 99,9% (GA) |
| Latensi API | p95 < 300 ms untuk read, p95 < 800 ms untuk write |
| Latensi push dashboard | < 2 detik dari event terjadi sampai terlihat di layar |
| Payroll run | 1.000 karyawan < 3 menit, 10.000 karyawan < 20 menit |
| Impor Excel | 5.000 baris < 60 detik dengan laporan galat per baris |
| RPO / RTO | RPO 5 menit (PITR), RTO 1 jam |
| Retensi audit | 7 tahun (mengacu kewajiban dokumen ketenagakerjaan & perpajakan) |
| Kepatuhan | UU PDP No. 27/2022, UU Ketenagakerjaan, PPh21 skema TER, BPJS TK & Kesehatan |

---

## 5. Daftar Dokumen Cetak Biru

| Berkas | Isi |
|--------|-----|
| `00-Analisis-Sistem-Referensi.md` | Dokumen ini — analisis referensi, gap, ruang lingkup |
| `01-Arsitektur-TechStack.md` | Arsitektur microservices, katalog service, komunikasi antar-service, konsistensi data, gateway & ingest menu berbasis langganan, tech stack |
| `02-Database-Modelling.md` | Skema PostgreSQL per service, replika baca, RLS, DDL, indexing |
| `03-Implementasi-Queue-WebSocket.md` | Event bus, outbox, saga & kompensasi, WebSocket, konkurensi terdistribusi |
| `04-Fase-Pengembangan.md` | Roadmap, tim, estimasi, DoD, manajemen risiko |
| `05-Dynamic-Role-Menu-Access.md` | Peran, menu, permission, grant & deny per pengguna, delegasi, access review |
| `06-Multitenancy-Auth.md` | Model multitenancy, `X-Tenant-ID`, autentikasi fase awal, siklus hidup tenant, noisy neighbor |
| `07-Dashboard-Global-Tenant.md` | Pemisahan control plane & tenant plane, dashboard global (superuser), dashboard tenant & tim, support session |
| `08-Katalog-Modul-Ekspansi.md` | Usulan modul tambahan, kerangka prioritas, modul yang sengaja tidak dibangun, dampak paket & harga |
| `09-Strategi-Migrasi-Non-Destruktif.md` | Aturan migrasi aditif, resep ALTER aman, backfill, tangga deprekasi, gerbang CI migrasi |
| `10-Presensi-Geolokasi-Foto.md` | Izin kamera & lokasi, geofence, bukti foto, penilaian kepercayaan berlapis, presensi luring, privasi |
| `11-PWA-Frontend.md` | Service worker, caching per tenant, antrean luring, Web Push, batas platform, anggaran performa |
| `12-Rencana-Eksekusi-Tim-Kecil.md` | **Rencana eksekusi untuk tim 1–3 orang.** Monolit modular siap dipecah, cakupan 4 modul inti, gerbang komersial, estimasi ulang. Menggantikan roadmap `04` §2–§10 |
| `13-Status-Implementasi.md` | **Keadaan sebenarnya**: apa yang sudah dibangun dan terbukti, penyimpangan dari rencana beserta alasannya, bug yang ditemukan lewat pengujian ujung-ke-ujung, dan yang masih terbuka. Dokumen `12` menyatakan niat; dokumen ini menyatakan keadaan |

**Urutan baca yang disarankan:** `00` → `01` → `06` → `07` → `05` → `02` → `09` → `03` → `10` → `11` → `04` → `08` → `12`.

Dokumen `12` dibaca berpasangan dengan `04`: `04` menyusun roadmap untuk tim 14–15 FTE di atas microservices penuh, `12` menyusun ulang eksekusinya untuk kapasitas tim nyata (1–3 orang) dengan monolit modular dan cakupan yang dipangkas. Bila keduanya bertentangan soal urutan, fase, atau estimasi, **`12` yang berlaku**; `04` tetap menjadi rujukan bila kapasitas tim kelak mencapai asumsinya.

Dokumen `11` dibaca berpasangan dengan `10`: PWA memperluas jangkauan presensi ke seluruh perangkat, tetapi melemahkan sebagian sinyal bukti yang dirancang di `10` — penyesuaiannya ada di `11` §2.2.

Dokumen `09` dibaca berpasangan dengan `02`: yang satu mendefinisikan bentuk skema, yang lain mendefinisikan cara skema itu boleh berubah.

Dokumen `06` dan `05` bersifat lintas-potong: keduanya mengikat seluruh service dan harus selesai sebelum service domain pertama ditulis. Dokumen `05` disusun untuk arsitektur berskema tunggal; §12 di dalamnya menjelaskan penyesuaian yang diperlukan agar berjalan sebagai `iam-service` mandiri.
