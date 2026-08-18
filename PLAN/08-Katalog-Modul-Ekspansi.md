# 08 — Katalog Modul Ekspansi & Prioritasnya

---

## 1. Kerangka Seleksi

Menambah modul terasa selalu benar — setiap modul baru adalah alasan baru untuk membeli. Padahal setiap modul juga menambah permukaan dukungan, beban regresi, kompleksitas UI, dan biaya pemeliharaan selamanya. Karena itu setiap usulan di dokumen ini dinilai dengan enam kriteria.

| Kriteria | Pertanyaan | Bobot |
|----------|-----------|-------|
| **Nyeri** | Seberapa sering masalah ini muncul, dan seberapa mahal akibatnya bila salah? | 25% |
| **Kelekatan (stickiness)** | Setelah dipakai, seberapa sulit pelanggan berpindah? | 20% |
| **Sinergi data** | Apakah modul ini memperkuat modul lain, atau berdiri sendiri? | 20% |
| **Kesediaan membayar** | Apakah pembeli melihatnya sebagai penghemat biaya atau sekadar fitur bagus? | 15% |
| **Biaya bangun** | Person-month sampai layak produksi | 10% (invers) |
| **Risiko regulasi** | Apakah salah hitung/salah lapor berakibat sanksi? | 10% (invers) |

### 1.1 Dua Aturan yang Membatasi Daftar Ini

**Aturan 1 — Kedalaman sebelum keluasan.** Sepuluh modul yang setengah matang kalah bersaing dengan empat modul yang benar-benar menyelesaikan pekerjaan. Pelanggan segmen UKM tidak membeli karena jumlah fitur; mereka membeli karena satu pekerjaan yang selama ini menyakitkan menjadi selesai.

**Aturan 2 — Setiap modul harus terhubung ke data yang sudah ada.** Modul yang tidak membaca atau menulis data karyawan, absensi, atau payroll pada dasarnya adalah produk lain yang kebetulan dijual bersamaan. Itu bukan ekspansi, itu pengalihan fokus.

### 1.2 Sinyal dari Produk Referensi

Dua hal yang perlu dibaca dari halaman referensi:

1. **Kanal distribusi berbasis komunitas HSE.** Tautan checkout Paket Basic mengarah ke `lynk.id/komunitashse`, sedangkan paket lain ke `lynk.id/hrscientist`. Penjualnya memiliki akses ke komunitas praktisi K3/HSE. Ini bukan detail sepele: modul **K3/HSE** memiliki jalur distribusi terpendek yang mungkin ada, karena audiensnya sudah terkumpul dan sudah pernah membeli. Modul lain harus mencari pasarnya sendiri.

2. **Struktur tiering sudah terbukti diterima.** Basic → Advanced → Ultimate dengan selisih harga 1,5–2× menunjukkan pasar bersedia membayar lebih untuk cakupan lebih. Modul baru harus punya tempat yang jelas dalam struktur ini, bukan menjadi daftar panjang tanpa logika pengelompokan.

---

## 2. Katalog Usulan

Notasi kompleksitas: **S** = 1–2 person-month, **M** = 3–5, **L** = 6–10, **XL** = > 10.

### 2.1 Kelompok A — Prioritas Tinggi (rekomendasi dibangun dalam 18 bulan)

---

#### A1. Onboarding & Offboarding

| | |
|---|---|
| **Masalah** | Karyawan baru masuk tanpa laptop, tanpa akses email, tanpa BPJS terdaftar. Karyawan resign membawa aset dan akun tetap aktif berbulan-bulan |
| **Pengguna** | HR Admin, IT, atasan langsung, karyawan baru |
| **Isi** | Templat checklist per jabatan, penugasan otomatis lintas departemen, pelacakan progres, serah terima aset, clearance keluar, exit interview |
| **Service host** | `onboarding-service` (baru) |
| **Ketergantungan** | `employee-service` (wajib), `recruitment-service` (opsional — konversi kandidat memicu onboarding) |
| **Kompleksitas** | M |
| **Tier** | Advanced |
| **Skor** | Nyeri tinggi · kelekatan tinggi · sinergi tinggi |

**Mengapa ini nomor satu:** onboarding adalah orkestrasi lintas departemen, dan orkestrasi lintas departemen adalah persis yang tidak bisa dilakukan spreadsheet. Ini juga modul dengan kelekatan tertinggi — begitu proses onboarding perusahaan berjalan di sistem, memindahkannya berarti mengubah cara kerja belasan orang.

```typescript
// service.manifest.ts
export default defineService({
  key: 'onboarding',
  name: 'Onboarding & Offboarding',
  tier: 'ADVANCED',
  requires: ['core.organization'],
  enhances: ['recruitment', 'asset', 'training'],
  subscribes: [
    'recruitment.candidate.hired',      // pemicu onboarding otomatis
    'employee.employee.created',
    'employee.employee.terminated',     // pemicu offboarding otomatis
  ],
  publishes: [
    'onboarding.journey.started', 'onboarding.task.completed',
    'onboarding.journey.completed', 'offboarding.clearance.completed',
  ],
});
```

```sql
-- onboarding_db
CREATE TABLE journey_templates (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ONBOARDING','OFFBOARDING')),
  name          text NOT NULL,
  position_ids  uuid[] NOT NULL DEFAULT '{}',   -- kosong = berlaku untuk semua jabatan
  org_unit_ids  uuid[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE template_tasks (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  template_id   uuid NOT NULL REFERENCES journey_templates(id) ON DELETE CASCADE,
  sequence      smallint NOT NULL,
  title         text NOT NULL,
  description   text,
  assignee_type text NOT NULL,        -- HR / IT / MANAGER / EMPLOYEE / SPECIFIC_ROLE
  assignee_role_key text,
  due_offset_days smallint NOT NULL,  -- relatif hari masuk/keluar; negatif = sebelum
  requires_evidence boolean NOT NULL DEFAULT false,
  blocks_completion boolean NOT NULL DEFAULT false,   -- clearance tidak selesai tanpa ini
  UNIQUE (template_id, sequence)
);

CREATE TABLE journeys (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  template_id   uuid NOT NULL REFERENCES journey_templates(id),
  employee_id   uuid NOT NULL,
  kind          text NOT NULL,
  reference_date date NOT NULL,       -- tanggal masuk atau tanggal keluar
  status        text NOT NULL DEFAULT 'IN_PROGRESS',
  progress_pct  smallint NOT NULL DEFAULT 0,
  completed_at  timestamptz,
  version       integer NOT NULL DEFAULT 1
);

CREATE TABLE journey_tasks (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  journey_id   uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  title        text NOT NULL,
  assignee_user_id uuid,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING',   -- PENDING/DONE/SKIPPED/OVERDUE
  evidence_key text,
  completed_by uuid,
  completed_at timestamptz,
  skip_reason  text
);
CREATE INDEX idx_journey_tasks_inbox ON journey_tasks (tenant_id, assignee_user_id, status)
  WHERE status IN ('PENDING','OVERDUE');
```

---

#### A2. Reimbursement & Klaim Karyawan

| | |
|---|---|
| **Masalah** | Klaim medis, transport, dan uang makan dikumpulkan lewat WhatsApp dan amplop, direkap manual, sering luput dari payroll |
| **Pengguna** | Seluruh karyawan (volume transaksi tinggi), HR, Finance |
| **Isi** | Pengajuan dengan foto struk, plafon per jenis dan per jabatan, alur persetujuan, pembayaran via payroll atau transfer terpisah, laporan per cost center |
| **Service host** | `claim-service` (baru) |
| **Ketergantungan** | `employee-service`, `payroll-service` (untuk pembayaran lewat gaji) |
| **Kompleksitas** | M |
| **Tier** | Advanced |

**Mengapa penting:** ini satu-satunya modul dalam daftar yang **dipakai hampir setiap karyawan setiap bulan**. Modul dengan sentuhan harian menciptakan kebiasaan, dan kebiasaan menciptakan retensi. Modul HR lain umumnya hanya disentuh tim HR.

**Peringatan lingkup:** batasi pada klaim karyawan. Begitu mulai menangani purchase request, vendor, dan jurnal akuntansi, ini berubah menjadi modul ERP dan tidak akan pernah selesai.

---

#### A3. K3 / HSE Management

| | |
|---|---|
| **Masalah** | Laporan kecelakaan kerja, inspeksi APD, HIRADC, dan pelaporan wajib K3 masih berbasis formulir kertas dan Excel |
| **Pengguna** | Petugas K3, supervisor lapangan, HR |
| **Isi** | Pelaporan insiden (termasuk *near miss*), investigasi akar masalah, HIRADC/JSA, inspeksi terjadwal, pelacakan APD, matriks sertifikasi K3, statistik FR/SR, laporan wajib |
| **Service host** | `hse-service` (baru) |
| **Ketergantungan** | `employee-service`, `training-service` (sertifikasi), `asset-service` (APD) |
| **Kompleksitas** | L |
| **Tier** | Ultimate atau add-on industri |

**Mengapa ini kandidat kuat meski bukan modul HR klasik:** kanal distribusi penjual sudah berupa komunitas HSE (§1.2). Ini berarti biaya akuisisi pelanggan untuk modul ini jauh lebih rendah dibanding modul lain mana pun dalam daftar. Selain itu, K3 bersifat wajib bagi manufaktur, konstruksi, dan pertambangan — segmen yang juga memiliki kebutuhan absensi shift paling kompleks, sehingga menarik mereka masuk lewat K3 kemudian menjual attendance adalah jalur yang masuk akal.

**Catatan kehati-hatian:** modul ini paling jauh dari kompetensi domain HR. Membangunnya membutuhkan ahli K3, bukan ahli HR. Jangan memulainya tanpa memastikan akses ke keahlian itu.

---

#### A4. Perjalanan Dinas (SPPD) & Kasbon

| | |
|---|---|
| **Masalah** | Uang muka perjalanan dinas dicatat di buku, pertanggungjawaban telat, sisa uang muka tidak tertagih |
| **Pengguna** | Karyawan, atasan, Finance, HR |
| **Isi** | Pengajuan SPPD, perhitungan uang harian sesuai golongan, uang muka, pertanggungjawaban dengan bukti, penyelesaian selisih lewat payroll. Kasbon/pinjaman karyawan dengan potongan cicilan otomatis |
| **Service host** | `claim-service` (satu service dengan A2 — konsepnya sama: pengajuan, persetujuan, penyelesaian finansial) |
| **Ketergantungan** | `payroll-service` (wajib — potongan cicilan) |
| **Kompleksitas** | M |
| **Tier** | Advanced |

**Konteks Indonesia:** kasbon adalah praktik yang hampir universal di UKM Indonesia dan hampir tidak pernah ditangani software HR asing. Potongan cicilan yang otomatis masuk ke payroll adalah pembeda yang sangat konkret dan mudah dijelaskan ke pembeli.

---

#### A5. Manajemen Kontrak & Pengingat Kepatuhan

| | |
|---|---|
| **Masalah** | PKWT berakhir tanpa disadari sehingga otomatis menjadi PKWTT. Sertifikat K3, SIM operator, dan izin kerja kedaluwarsa tanpa peringatan |
| **Pengguna** | HR Admin, Legal |
| **Isi** | Pelacakan masa berlaku kontrak, sertifikat, dan izin. Pengingat berjenjang (H-90, H-30, H-7). Alur perpanjangan. Templat kontrak. Tanda tangan digital (opsional) |
| **Service host** | Perluasan `employee-service` — bukan service baru |
| **Ketergantungan** | — |
| **Kompleksitas** | S |
| **Tier** | Basic (nilai per biaya paling tinggi dalam daftar) |

**Mengapa ini kandidat terbaik dari sisi rasio nilai/biaya:** kompleksitasnya kecil (data kontrak dan dokumen sudah ada di `employee-service`; yang ditambahkan hanya mesin pengingat), tetapi konsekuensi kegagalannya besar dan mudah dipahami pembeli. Satu PKWT yang lolos berubah menjadi PKWTT adalah kerugian hukum permanen yang nilainya jauh melebihi biaya langganan setahun.

---

### 2.2 Kelompok B — Prioritas Menengah (kandidat 18–30 bulan)

---

#### B1. Training & Sertifikasi

| | |
|---|---|
| **Masalah** | Riwayat pelatihan tercecer, sertifikat wajib kedaluwarsa, anggaran pelatihan tidak terlacak |
| **Isi** | Katalog pelatihan, pendaftaran, riwayat per karyawan, matriks kompetensi, masa berlaku sertifikat, anggaran & realisasi, evaluasi pasca-pelatihan |
| **Service host** | `training-service` (baru) |
| **Ketergantungan** | `performance-service` (kesenjangan kompetensi), `planning-service` (IDP), `hse-service` (sertifikasi K3) |
| **Kompleksitas** | M |
| **Tier** | Ultimate |

**Batas lingkup yang harus dijaga:** ini adalah **pencatatan pelatihan**, bukan LMS. Jangan membangun pemutar video, kuis, SCORM, atau forum diskusi. LMS penuh adalah produk tersendiri dengan tim tersendiri; mencampurnya ke HRIS menghasilkan LMS yang buruk sekaligus HRIS yang berat.

---

#### B2. Manajemen Aset & Inventaris

| | |
|---|---|
| **Masalah** | Laptop, kendaraan, seragam, dan APD tidak terlacak; barang hilang saat karyawan keluar |
| **Isi** | Registrasi aset, penugasan ke karyawan, berita acara serah terima, jadwal pemeliharaan, penyusutan sederhana, integrasi clearance offboarding |
| **Service host** | `asset-service` (baru) |
| **Ketergantungan** | `employee-service`, `onboarding-service` |
| **Kompleksitas** | M |
| **Tier** | Advanced |

Modul ini melipatgandakan nilai A1 (onboarding/offboarding) — clearance keluar tanpa daftar aset hanyalah checklist kosong.

---

#### B3. Penjadwalan Shift Lanjutan (Roster Planning)

| | |
|---|---|
| **Masalah** | Penjadwalan shift manufaktur/retail/rumah sakit dibuat manual di Excel setiap minggu, sering melanggar batas jam kerja |
| **Isi** | Pola shift berulang, penjadwalan berbasis kebutuhan, tukar shift antar karyawan dengan persetujuan, validasi aturan (jam istirahat minimum, batas lembur), perkiraan biaya sebelum jadwal dikunci |
| **Service host** | Perluasan `attendance-service` |
| **Kompleksitas** | L |
| **Tier** | Ultimate atau add-on industri |

**Kandidat modul dengan kesediaan membayar tertinggi** di segmen manufaktur dan rumah sakit, karena penjadwalan yang buruk berdampak langsung pada biaya lembur. Tetapi kompleksitas algoritmanya nyata (ini masalah optimasi berbatasan), jadi jangan diremehkan.

---

#### B4. Survei & Keterlibatan Karyawan

| | |
|---|---|
| **Isi** | Pulse survey, eNPS, survei kepuasan, jawaban anonim dengan ambang minimum responden, tren per unit |
| **Service host** | `engagement-service` (baru) |
| **Kompleksitas** | S–M |
| **Tier** | Ultimate |

Modul murah dibangun dengan nilai persepsi tinggi bagi manajemen. Perhatikan ambang anonimitas: hasil survei unit berisi 4 orang tidak boleh ditampilkan per unit — masalah yang sama persis dengan yang dibahas di dokumen `07` §4.4.

---

#### B5. Helpdesk HR (Ticketing)

| | |
|---|---|
| **Masalah** | Pertanyaan karyawan (surat keterangan kerja, koreksi absensi, pertanyaan BPJS) datang lewat WhatsApp pribadi HR tanpa jejak |
| **Isi** | Tiket berkategori, SLA, basis pengetahuan, templat surat otomatis, laporan beban kerja HR |
| **Service host** | `helpdesk-service` (baru) |
| **Kompleksitas** | M |
| **Tier** | Advanced |

Modul ini memberi HR argumen kuantitatif untuk penambahan staf — data yang sebelumnya tidak pernah mereka miliki.

---

#### B6. Kepatuhan & Pelaporan Wajib

| | |
|---|---|
| **Isi** | WLKP (Wajib Lapor Ketenagakerjaan), rekap BPJS, dukungan e-SPT 1721, laporan tenaga kerja asing, arsip bukti pelaporan |
| **Service host** | Perluasan `payroll-service` dan `employee-service` |
| **Kompleksitas** | M, tetapi **pemeliharaan tinggi** (format berubah mengikuti regulasi) |
| **Tier** | Ultimate |

**Peringatan jujur:** modul ini menghasilkan utang pemeliharaan permanen. Setiap perubahan format pelaporan pemerintah menjadi pekerjaan wajib dengan tenggat yang tidak bisa dinegosiasikan. Bangun hanya bila ada komitmen sumber daya berkelanjutan, bukan sebagai proyek sekali jadi.

---

### 2.3 Kelompok C — Kandidat Jangka Panjang

| Modul | Catatan singkat |
|-------|-----------------|
| **Compensation Review Cycle** | Siklus kenaikan gaji berbasis kinerja, simulasi anggaran, matriks merit. Bergantung pada `performance-service` yang matang |
| **Succession & Talent Pool** | 9-box sudah ada di performance; ini menambah peta suksesi dan kesiapan pengganti |
| **People Analytics Lanjutan** | Prediksi turnover, cost-to-hire, analisis kesenjangan gaji. Butuh data historis 12–24 bulan agar bermakna — jangan dibangun terlalu awal |
| **Manajemen Vendor Outsourcing** | Relevan untuk perusahaan dengan tenaga alih daya besar; kompleksitas kontrak tinggi |
| **Timesheet & Project Costing** | Untuk konsultan/agensi: jam kerja billable per proyek. Segmen berbeda dari pasar inti |
| **Multi-Entity / Grup Perusahaan** | Satu tenant dengan beberapa badan hukum, payroll terpisah, laporan konsolidasi. **Ini jawaban yang benar untuk kebutuhan "lihat data tenant lain"** (dok. 07 R25) |
| **Integration Hub & Open API** | Webhook, API publik, konektor akuntansi. Monetisasi per panggilan atau tier |
| **Whistleblowing Channel** | Pelaporan anonim dengan kerahasiaan ketat; secara teknis perluasan `relation-service` dengan ACL lebih keras |
| **Employee Benefits Marketplace** | Asuransi tambahan, wellness. Model bisnis komisi — pada dasarnya lini bisnis berbeda |

---

## 3. Yang Sebaiknya **Tidak** Dibangun

Daftar ini sama pentingnya dengan daftar di atas.

| Ide | Alasan menolak |
|-----|----------------|
| **LMS penuh** (video, SCORM, kuis, forum) | Produk tersendiri dengan tim tersendiri. Cukup catat riwayat pelatihan (B1) dan integrasikan dengan LMS pihak ketiga |
| **Akuntansi & keuangan penuh** | Kompetisi langsung dengan Accurate/Jurnal/Xero yang jauh lebih matang. Bangun ekspor jurnal, bukan buku besar |
| **Payroll multi-negara** | Setiap negara adalah proyek berbulan-bulan. Kuasai Indonesia dulu sampai benar-benar mendalam |
| **Video interview & AI screening** | Biaya tinggi, diferensiasi rendah, sudah banyak penyedia khusus. Integrasikan, jangan bangun |
| **Chat internal / social feed** | Kalah telak dari WhatsApp dan Slack. Cukup pengumuman satu arah |
| **Mesin absensi (perangkat keras)** | Bisnis manufaktur, bukan perangkat lunak. Bangun konektornya saja |
| **Manajemen proyek umum** | Bukan HR. Timesheet untuk penggajian berbeda dari Asana |
| **CRM / penjualan** | Sama sekali di luar domain |

**Pola yang perlu dikenali:** setiap ide di tabel ini terasa seperti "hanya menambah satu fitur lagi" saat pertama kali diusulkan — biasanya oleh pelanggan besar yang bersedia membayar. Justru itu yang membuatnya berbahaya. Uji sederhananya: bila fitur itu tidak membaca data karyawan, absensi, atau payroll, ia bukan ekspansi produk ini.

---

## 4. Rekomendasi Prioritas

### 4.1 Daftar Pendek 18 Bulan

Bila hanya boleh memilih lima, urutannya:

| # | Modul | Alasan urutan | Kompleksitas | Tier |
|---|-------|---------------|--------------|------|
| 1 | **Kontrak & Pengingat Kepatuhan** (A5) | Rasio nilai/biaya tertinggi; perluasan service yang sudah ada; risiko hukum mudah dijelaskan ke pembeli | S | Basic |
| 2 | **Reimbursement & Klaim** (A2) | Satu-satunya modul dengan sentuhan harian oleh seluruh karyawan; pendorong retensi terkuat | M | Advanced |
| 3 | **Onboarding & Offboarding** (A1) | Kelekatan tertinggi; memanfaatkan seluruh data yang sudah ada | M | Advanced |
| 4 | **SPPD & Kasbon** (A4) | Berbagi service dengan A2 sehingga biaya marginalnya rendah; sangat khas Indonesia | M | Advanced |
| 5 | **K3 / HSE** (A3) | Biaya akuisisi pelanggan terendah berkat kanal komunitas yang sudah ada | L | Ultimate |

**Total tambahan: ± 18–22 person-month**, tersebar setelah Fase 4.

### 4.2 Urutan dan Alasannya

Urutan ini bukan berdasarkan besarnya nilai, melainkan **kombinasi nilai dan momentum**:

- Nomor 1 dan 2 sengaja dipilih yang cepat selesai, agar ada bukti pengiriman nilai baru sebelum masuk ke modul besar.
- Nomor 2 dan 4 berbagi satu service (`claim-service`), sehingga membangun keduanya berurutan jauh lebih murah daripada terpisah jauh.
- Nomor 5 diletakkan terakhir karena membutuhkan keahlian domain yang belum tentu ada di tim, dan itu perlu waktu untuk disiapkan.

### 4.3 Keputusan yang Perlu Diambil Sebelum Memulai

| Pertanyaan | Mengapa perlu diputuskan dulu |
|------------|------------------------------|
| Apakah K3/HSE menjadi lini produk terpisah atau modul HRIS? | Bila terpisah, ia butuh dashboard, peran, dan bahkan pembeli sendiri (petugas K3, bukan HR). Jawabannya mengubah arsitektur |
| Apakah Reimbursement membayar lewat payroll atau transfer terpisah? | Bila lewat payroll, ada ketergantungan keras ke `payroll-service` dan modul ini tidak bisa dijual ke pelanggan Paket Basic |
| Siapa ahli domain untuk K3 dan pelaporan wajib? | Kedua modul ini tidak bisa dibangun dari dokumen saja |
| Apakah Multi-Entity masuk daftar? | Ini satu-satunya jawaban arsitektural yang benar untuk permintaan "lihat data perusahaan lain dalam satu grup" (dok. `07` R25). Bila banyak calon pelanggan berbentuk grup, prioritasnya naik tajam |

---

## 5. Dampak Arsitektur

### 5.1 Service Baru vs Perluasan Service Lama

| Modul | Keputusan | Alasan |
|-------|-----------|--------|
| Kontrak & Kepatuhan (A5) | Perluasan `employee-service` | Data kontrak dan dokumen sudah ada di sana; memecahnya hanya menambah panggilan lintas service |
| Reimbursement (A2) + SPPD/Kasbon (A4) | Satu `claim-service` baru | Konsepnya identik: pengajuan → persetujuan → penyelesaian finansial. Memisahkannya menghasilkan dua service yang 70% kodenya sama |
| Onboarding (A1) | `onboarding-service` baru | Orkestrasi tugas lintas departemen adalah domain tersendiri dengan siklus hidup sendiri |
| K3/HSE (A3) | `hse-service` baru | Domain paling jauh dari HR; batas tegas memudahkan penjualan terpisah nanti |
| Training (B1) | `training-service` baru | Berdiri sendiri, banyak dibaca modul lain |
| Aset (B2) | `asset-service` baru | Siklus hidup aset independen dari karyawan |
| Roster (B3) | Perluasan `attendance-service` | Jadwal dan absensi adalah satu bounded context; memisahkannya menciptakan kopling ketat lintas service |

**Prinsip yang dipakai:** service baru dibuat bila domainnya memiliki siklus hidup dan bahasa sendiri. Perluasan dipilih bila datanya sudah ada dan pemisahan hanya akan menghasilkan panggilan gRPC yang bolak-balik.

Bila seluruh Kelompok A dan B dibangun, jumlah service menjadi **24** (18 saat ini + 6 baru). Ini melewati ambang di mana beban operasional perlu ditinjau ulang — lihat §7.

### 5.2 Event Baru Lintas Service

```typescript
// packages/contracts/src/events/expansion.ts
'onboarding.journey.started'        // → notification, asset (siapkan aset), training (daftarkan induksi)
'onboarding.journey.completed'      // → employee (tandai onboarding selesai), reporting
'offboarding.clearance.completed'   // → payroll (izinkan final settlement), auth (nonaktifkan akun), asset
'claim.submitted'                   // → notification
'claim.approved'                    // → payroll (masukkan ke komponen gaji berikutnya)
'loan.installment.scheduled'        // → payroll (potongan cicilan)
'contract.expiring'                 // → notification, onboarding (siapkan perpanjangan)
'certification.expiring'            // → notification, hse (blokir penugasan bila sertifikat mati)
'asset.assigned' / 'asset.returned' // → onboarding, reporting
'hse.incident.reported'             // → notification (eskalasi), relation (bila melibatkan kelalaian)
'training.completed'                // → performance (perbarui kompetensi), planning (progres IDP)
```

Satu ketergantungan yang perlu perhatian khusus: **`offboarding.clearance.completed` menjadi gerbang bagi final settlement payroll.** Ini berarti `payroll-service` kini memiliki prasyarat baru dari service yang mungkin tidak dilanggan tenant. Penanganannya mengikuti prinsip P3 di dokumen `00`: bila modul onboarding tidak aktif, payroll tidak menunggu event yang tidak akan pernah datang.

```typescript
// services/payroll-service/src/application/final-settlement.usecase.ts
async canRunFinalSettlement(tenantId: string, employeeId: string): Promise<GateResult> {
  const hasOnboarding = await this.subscription.hasModule(tenantId, 'onboarding');

  // Modul tidak dilanggan → tidak ada gerbang clearance sama sekali.
  // Konsumen event harus toleran terhadap event yang tidak pernah datang.
  if (!hasOnboarding) return { allowed: true };

  const clearance = await this.clearanceRef.find(tenantId, employeeId);
  if (!clearance?.completedAt) {
    return { allowed: false,
      reason: 'Clearance offboarding belum selesai. Selesaikan serah terima aset terlebih dahulu.' };
  }
  return { allowed: true };
}
```

---

## 6. Dampak pada Paket & Harga

### 6.1 Usulan Struktur Paket Setelah Ekspansi

| Paket | Modul | Positioning |
|-------|-------|-------------|
| **Basic** | core.organization, attendance, leave, performance, **contract-compliance** | Administrasi HR dasar + pengaman risiko hukum |
| **Advanced** | Basic + payroll, planning (RACI/DACI), relation, **claim**, **onboarding**, **asset**, **helpdesk** | Operasional HR menyeluruh |
| **Ultimate** | Advanced + recruitment, planning (FTE, IDP), **training**, **engagement**, **compliance-reporting** | Pengelolaan siklus hidup karyawan penuh |
| **Add-on industri** | **hse**, **roster-planning**, **multi-entity** | Dibeli terpisah sesuai kebutuhan industri |

**Perubahan penting dari struktur referensi:** memindahkan `contract-compliance` ke Basic. Modul termurah dibangun ditempatkan di paket termurah, sebagai pembeda dari produk Excel — sesuatu yang secara harfiah tidak mungkin dilakukan spreadsheet adalah mengirim pengingat.

### 6.2 Add-on Industri sebagai Kategori Terpisah

K3/HSE, Roster Planning, dan Multi-Entity tidak dimasukkan ke jenjang paket, melainkan dijual sebagai add-on. Alasannya: ketiganya bernilai sangat tinggi bagi sebagian kecil pelanggan dan nyaris tidak bernilai bagi sebagian besar. Memasukkannya ke Ultimate berarti menaikkan harga Ultimate untuk semua orang demi fitur yang hanya dipakai 20%.

Secara teknis, arsitektur sudah mendukung ini sepenuhnya: `tenant_modules.source` sudah membedakan `PLAN` dari `ADDON` (dokumen `02`, §3).

---

## 7. Dampak pada Roadmap & Batas Kapasitas

### 7.1 Penempatan Fase

| Fase | Modul ekspansi |
|------|----------------|
| **Fase 2** (bersamaan payroll) | **A5 — Kontrak & Kepatuhan** (kompleksitas S, memanfaatkan `employee-service` yang sudah selesai; tidak mengganggu jalur kritis payroll) |
| **Fase 4** (bersamaan marketplace) | **A2 — Reimbursement** dan **A4 — SPPD & Kasbon** (satu service, dibangun berurutan) |
| **Fase 5** | **A1 — Onboarding & Offboarding**, **B2 — Aset** (saling menguatkan, dibangun berpasangan) |
| **Fase 6 (baru)** | **A3 — K3/HSE** sebagai add-on industri; **B1 — Training** |
| Ditinjau ulang | Seluruh Kelompok B lainnya dan Kelompok C, berdasarkan data penggunaan nyata |

**Tambahan estimasi:**

| Kelompok | Person-month |
|----------|--------------|
| A5 (Fase 2) | 2 |
| A2 + A4 (Fase 4) | 8 |
| A1 + B2 (Fase 5) | 9 |
| A3 (Fase 6) | 8 |
| **Total daftar pendek** | **± 27** |

Total proyek menjadi **± 264 person-month** sebelum buffer, **± 317** sesudah buffer 20%.

### 7.2 Batas Kapasitas yang Perlu Diakui

Dengan 24 service, dua hal harus ditinjau ulang secara jujur:

1. **Rasio Platform/SRE.** Dua FTE cukup untuk 18 service. Pada 24 service dengan 24 basis data, 24 pipeline deploy, dan 24 set alert, kemungkinan besar dibutuhkan tiga. Ini bukan biaya sekali bayar — ini biaya berjalan seumur produk.

2. **Kapan berhenti menambah service.** Setiap modul baru setelah ini sebaiknya dievaluasi dengan pertanyaan: apakah ia benar-benar butuh service sendiri, atau bisa menjadi bounded context di dalam service yang sudah ada? Kecenderungan alami tim yang terbiasa dengan microservices adalah membuat service baru untuk segalanya, dan itu berakhir pada armada yang tidak seorang pun bisa jalankan secara lokal.

**Indikator yang harus dipantau:** bila jumlah service tersentuh per PR (median) naik konsisten di atas 2, batas service sedang salah dan penambahan modul baru harus dihentikan sampai dibenahi. Metrik ini sudah ada di dokumen `04`, §12.

---

## 7.3 Migrasi Modul Baru

Setiap modul ekspansi menambah tabel, kolom, permission, dan menu. Seluruhnya mengikuti aturan dokumen `09`:

| Jenis penambahan | Cara |
|------------------|------|
| Service & basis data baru (`claim_db`, `onboarding_db`, dst.) | `CREATE DATABASE` + `00_foundation.sql` + `apply_rls_everywhere()`. Satu-satunya kasus `CREATE DATABASE`, tanpa `DROP` apa pun |
| Tabel baru di service lama (`contract-compliance` di `employee_db`) | `CREATE TABLE IF NOT EXISTS` + RLS |
| Kolom baru pada tabel yang sudah berisi data | Nullable atau ber-default konstanta; `NOT NULL` hanya lewat pola empat langkah (dok. `09` §3.3) |
| Permission & menu baru | `INSERT ... ON CONFLICT DO NOTHING` saat `onEnable` |
| Event baru | Aditif; tidak mengubah kontrak yang ada |
| Kolom baru pada `employee_ref` di banyak service | Urutan wajib di dokumen `09` §6.3 — sumber dulu, konsumen kemudian |

**Yang perlu diperhatikan khusus:** `claim-service` menambahkan komponen potongan baru ke payroll (cicilan kasbon). Ini berarti kolom atau baris baru di `payroll_db`, dan slip gaji yang sudah terbit **tidak boleh berubah karenanya**. Penambahan komponen mengikuti pola berdimensi waktu di dokumen `09` §9.3: komponen baru punya `effective_from` sendiri, bukan menimpa konfigurasi lama.

---

## 8. Risiko

| # | Risiko | Prob. | Dampak | Mitigasi |
|---|--------|-------|--------|----------|
| **R26** | **Ekspansi lingkup mendahului kedalaman** — banyak modul, semuanya setengah matang | **Tinggi** | **Tinggi** | Daftar pendek 5 modul dengan gerbang eksplisit: modul berikutnya tidak dimulai sebelum adopsi modul sebelumnya > 30% dari basis pelanggan yang berhak |
| R27 | Modul kepatuhan (B6) menjadi utang pemeliharaan permanen | Tinggi | Sedang | Bangun hanya dengan komitmen sumber daya berjalan; format pelaporan dibuat sebagai konfigurasi berversi, bukan kode |
| R28 | K3/HSE dibangun tanpa ahli domain | Sedang | Tinggi | Tidak memulai sebelum ahli K3 terlibat; validasi dengan 3 perusahaan manufaktur sebelum menulis kode |
| R29 | Jumlah service melewati kapasitas operasi tim | Sedang | Tinggi | Ambang peninjauan pada 20 service; prioritaskan perluasan service lama dibanding service baru |
| R30 | Ketergantungan baru membuat modul lama gagal saat modul baru tidak dilanggan | Sedang | Sedang | Prinsip P3: setiap konsumen event harus toleran terhadap event yang tidak pernah datang; diuji eksplisit |
| R31 | Add-on industri memecah fokus tim ke dua pasar berbeda | Sedang | Sedang | K3/HSE dijalankan sebagai jalur terpisah dengan tim kecil khusus, bukan dibebankan ke tim inti |

---

## 9. Metrik Evaluasi Modul

Setiap modul yang dirilis dievaluasi setelah 90 hari. Modul yang gagal memenuhi ambang tidak otomatis dihapus, tetapi tidak boleh mendapat investasi lanjutan sampai penyebabnya dipahami.

| Metrik | Ambang |
|--------|--------|
| Adopsi (tenant berhak yang mengaktifkan) | ≥ 30% dalam 90 hari |
| Penggunaan aktif (tenant yang memakainya ≥ 1×/bulan) | ≥ 60% dari yang mengaktifkan |
| Kontribusi terhadap konversi upgrade paket | Terukur, ≥ 10% dari upgrade menyebutkannya |
| Tiket dukungan per tenant aktif per bulan | < 0,5 |
| Dampak pada retensi | Tenant dengan modul ini memiliki churn lebih rendah dari rata-rata |

> Ambang adopsi 30% dipilih dengan sengaja: modul yang hanya dipakai seperempat pelanggan yang berhak biasanya menandakan salah satu dari tiga hal — tidak menyelesaikan masalah nyata, terlalu sulit dipakai, atau tidak diketahui keberadaannya. Ketiganya perlu diperbaiki sebelum menambah modul berikutnya.
