# 13 — Status Implementasi

Dokumen ini mencatat **apa yang sudah benar-benar dibangun**, apa yang menyimpang
dari rencana, dan apa yang masih terbuka. Ia melengkapi dokumen `12` (peta jalan)
tanpa menggantikannya: `12` menyatakan niat, dokumen ini menyatakan keadaan.

Alasan dokumen ini ada terpisah: daftar centang di dalam peta jalan cenderung
dicentang karena "fiturnya ada", sementara yang menentukan kelayakan rilis adalah
apakah fitur itu **terbukti bekerja pada jalur yang sebenarnya**. Yang dicatat di
sini karena itu selalu disertai cara pembuktiannya.

Terakhir diperbarui: 28 Agustus 2026.

---

## 1. Ringkasan

| Fase | Lingkup | Status |
|------|---------|--------|
| F0 | Fondasi: RLS, autentikasi, IAM, outbox, migrasi aditif | Selesai |
| F1 | Multi-tenant, modul, langganan, dua bidang (tenant/admin) | Selesai |
| F2 | Karyawan, impor/ekspor Excel, PII, kontrak, grid, dokumen | Selesai |
| F3 | Presensi, PWA, bukti, kepercayaan, persetujuan, dasbor langsung | Selesai |
| F4 | Cuti | Selesai |
| F5 | Payroll | **Kerangka selesai; perhitungan pajak & BPJS terkunci Gerbang C** |
| F6 | Komersialisasi | **Semua selesai kecuali penagihan (butuh akun payment gateway)** |
| F7 | Observabilitas, kesiapan produksi | Sebagian — probe kesehatan, cadangan, dan log terstruktur selesai |

Gerbang A (tiga pilot mengimpor mandiri) dan Gerbang B (satu tenant membayar)
**belum diuji** — keduanya menuntut pengguna nyata, bukan kode.

---

## 2. Penyimpangan dari rencana

Penyimpangan dicatat beserta alasannya. Yang tidak dicatat akan terbaca sebagai
kelalaian oleh siapa pun yang membaca rencana dan kode secara berdampingan.

### 2.1 Zona waktu tenant — TAMBAHAN, tidak ada di rencana mana pun

Dokumen `02` dan `10` sama-sama tidak menyebut zona waktu. Implementasinya
menghitung seluruh batas hari dalam UTC, dan untuk WIB (UTC+7) itu berarti
**setiap ketukan presensi antara 06:00 dan 10:59 pagi tercatat pada tanggal
kemarin** — jendela kedatangan hampir seluruh angkatan kerja Indonesia.

Akibatnya berantai: setiap hari kerja hanya punya ketukan pulang, setiap hari
dihitung `ABSENT`, dan setiap potongan gaji yang mengikutinya salah. Tidak satu
pun galat muncul.

Bug yang sama mengenai perbandingan jadwal: `startMinute` 480 diterjemahkan
menjadi pukul 08:00 **UTC** = 15:00 WIB, sehingga tidak ada seorang pun yang
pernah tercatat terlambat.

Kolom `tenant.tenants.timezone` (nama IANA, bawaan `Asia/Jakarta`) ditambahkan
lewat migrasi aditif, dan seluruh batas hari kerja kini dihitung di zona tenant.

> **Konsekuensi untuk rencana:** payroll (F5) menghitung dari `attendance_days`.
> Bug ini akan muncul kembali sebagai selisih gaji bila F5 dibangun di atas data
> yang dihitung sebelum perbaikan ini.

### 2.2 AG Grid 36, bukan 33

Dokumen `01` §669 menyebut AG Grid Community 33.x. Yang dipasang 36.1 — versi
stabil terkini saat implementasi. Perbedaan yang berdampak: sejak 33, modul
harus didaftarkan eksplisit (`ModuleRegistry.registerModules`), dan tanpa itu
gridnya kosong **tanpa satu pun galat di konsol**.

### 2.3 Realtime: SSE + LISTEN/NOTIFY, bukan Socket.IO + Redis

Sudah diputuskan di dokumen `12` §3 dan dilaksanakan apa adanya. Yang perlu
dicatat sebagai batasan operasional: kanal `LISTEN` **per tenant**, karena
`LISTEN`/`NOTIFY` berada di luar jangkauan RLS — satu kanal bersama akan
mengirimkan aktivitas presensi seluruh tenant ke setiap proses yang mendengarkan.

Setiap aliran memegang satu koneksi PostgreSQL; batasnya 32 aliran per proses.
Melewati batas itu, dasbor jatuh ke polling 20 detik, dan itu dinyatakan di layar.

### 2.4 Cuti: persetujuan satu langkah, skema berjenjang

Dokumen `12` menyebut "alur persetujuan berjenjang". Yang dibangun adalah satu
langkah — penyetuju dipilih pengaju, dan keputusannya final.

Tabel `leave_approvals` sudah berbentuk berjenjang (`step_order`, satu baris per
langkah), sehingga menambahkan langkah kedua kelak tidak menuntut migrasi
struktural. Yang belum ada hanyalah aturan siapa penyetuju berikutnya — dan
aturan itu berbeda di setiap perusahaan, sehingga menebaknya sekarang berarti
membangun sesuatu yang akan dibongkar oleh pelanggan pertama yang memakainya.

### 2.5 Payroll: kerangka dibangun, aturan pajak tidak

Dokumen `12` menetapkan Gerbang C sebagai prasyarat keras sebelum baris pertama
F5 ditulis. Yang dibangun di sini adalah bagian yang **tidak menuntut penafsiran
peraturan**, dan pemisahannya dijaga dengan sengaja:

**Dibangun** — parser formula berdaftar-izin tanpa `eval`, komponen gaji yang
dapat dikonfigurasi, struktur gaji berperiode (P13), siklus run dengan
idempotensi, slip gaji beserta jejak perhitungan per baris, dan
`statutory_configs` berversi tanggal sebagai tempat tarif kelak disimpan.

**TIDAK dibangun** — PPh21, PTKP, BPJS, prorata, dan lembur menurut Kepmenaker.
Seluruhnya menuntut ahli payroll dan 30 slip nyata sebagai kasus uji.
Menuliskannya dari pembacaan peraturan sendiri menghasilkan angka yang terlihat
masuk akal dan salah, dan salah menghitung pajak karyawan adalah kewajiban hukum
yang ditanggung pelanggan.

Ketika Gerbang C terbuka, PPh21 dan BPJS masuk sebagai komponen bertipe
`DEDUCTION` yang membaca `statutory_configs` — tanpa mengubah mesin perhitungan.

Layar Proses Penggajian menyatakan batasan ini di bagian paling atas, bukan di
catatan kaki. HR yang mengira pajaknya sudah dihitung akan membayarkan gaji yang
kurang potong.

### 2.6 Impor mesin absensi: generik, bukan per vendor

Sesuai keputusan dokumen `12` ("konektor asli dibangun saat ada pelanggan yang
membayar untuk itu"). Yang dibangun adalah pengenalan kolom generik dengan alias,
terbukti pada tiga format nyata: ZKTeco (`Date/Time` + `C/In`/`C/Out`), format
Indonesia (`dd/mm/yyyy` + kolom jam terpisah), dan ekspor tanpa kolom status.

Keputusan yang tidak dapat dihindari dan perlu diketahui: ketika mesin tidak
menyatakan jenis ketukan, **ketukan pertama pada satu hari dianggap masuk dan
sisanya pulang** — bukan berselang-seling. Berselang-seling terlihat lebih
pintar dan lebih rapuh: satu tempelan jari yang tidak terbaca akan membalik
seluruh sisa hari itu.

---

## 3. Yang terbukti, dan cara membuktikannya

Yang tercantum di sini sudah dijalankan ujung-ke-ujung terhadap sistem yang
berjalan, bukan hanya lolos uji unit.

| Klaim | Bukti |
|-------|-------|
| Presensi di luar geofence tetap tercatat dan ditandai | Skor 35, `review=NEEDS_REVIEW`, baris tersimpan |
| EXIF terhapus dari setiap foto | Berkas uji berisi `GPSLatitude` diunggah; berkas tersimpan tidak memuatnya, JFIF tetap utuh |
| Foto kedaluwarsa terhapus, catatan presensi utuh | Job retensi: `deleted=1`, berkas hilang, 9 baris presensi tetap ada |
| Kegagalan penghapusan foto TIDAK menghapus rujukannya | Direktori bernama sama → `EPERM` → `failed=1`, rujukan DB bertahan, putaran berikutnya menyelesaikannya |
| Ketukan luring tidak menggandakan | `dedupeKey` sama dikirim ulang → HTTP 200, satu baris |
| Impor mesin absensi idempoten | Berkas sama diimpor dua kali → `insertedRows=0, duplicateRows=4` |
| Batas hari kerja benar di WIB dan WIT | 06:00–11:00 WIB seluruhnya jatuh pada tanggal yang benar; 01:30 WIT tetap milik hari kerja sebelumnya |
| Penarikan persetujuan berlaku di server | Koordinat dikirim klien → `latitude=NULL` tersimpan |
| Penarikan persetujuan tidak menghukum | Penalti 0, `review=ACCEPTED` — persetujuan yang diberikan karena takut tidak sah menurut UU PDP |
| Akses HR ke foto dan dokumen dicatat (PR6) | Pemilik membuka → 0 catatan; HR membuka → 1 catatan |
| Muatan dasbor langsung tanpa koordinat (PR8) | Medan terkirim: id, employeeId, type, source, punchedAt, workDate, trustScore, review, workSiteId |
| Dasbor langsung < 2 detik | Terukur 305 ms dari ketukan sampai tiba di aliran |
| Berkas berbahaya bernama `.pdf` ditolak | Jenis ditentukan dari angka ajaib isinya, bukan dari nama maupun `content-type` |
| Dokumen diarsipkan, tidak dihapus | Berkas hilang, baris bertahan, pembukaan berikutnya 410 |
| Periode tertutup menolak koreksi manual | HTTP 409 dengan pesan eksplisit; tidak ada baris tersimpan diam-diam |
| **50 persetujuan cuti simultan pada saldo 2 hari → tepat 1 berhasil** | Terukur: 1 berhasil, 49 konflik 409. DoD Fase 4 |
| Saldo cuti tidak pernah minus | Kolom GENERATED + `chk_no_negative_balance`; saldo akhir 0, bukan −2 |
| Setiap mutasi saldo punya baris buku besar | GRANT / HOLD / ADJUST / CONSUME / EXPIRE seluruhnya tercatat |
| Cuti tumpang tindih ditolak basis data | Constraint EXCLUDE `daterange` inklusif; HTTP 409 |
| Cuti sakit dan melahirkan tidak memotong jatah tahunan | Saldo tahunan tidak bergerak setelah pengajuan cuti sakit |
| Hari bercuti tidak dihitung alfa | Rekap harian ABSENT → LEAVE setelah cuti disetujui |
| Penutupan tahun idempoten | Sisa 10 hari, batas bawa 6 → dibawa 6, hangus 4; putaran kedua tidak menggandakan |
| Formula gaji tidak dapat mengeksekusi kode | `eval`, `require`, `process`, `globalThis`, `__proto__` seluruhnya ditolak parser |
| Formula salah ditolak saat DISIMPAN, bukan saat run | Variabel tak dikenal → HTTP 400 dengan daftar yang tersedia |
| Siklus komponen ditolak dengan rantainya disebut | `A_KOMP → B_KOMP → A_KOMP` |
| Aritmetika gaji desimal, bukan float | `0.1 + 0.2` menghasilkan tepat `0.3` |
| Run ganda pada periode sama → tepat satu | Dua permintaan bersamaan: 201 dan 409 |
| Hitung ulang run tidak menggandakan slip | Slip tetap 3, bukan 6 |
| Struktur gaji berperiode dipakai benar | Run Maret memakai gaji 8 juta, bukan 10 juta yang berlaku Juli |
| Slip orang lain tidak dapat dibuka karyawan | 403; HR 200 |
| Slip belum disetujui tidak menampilkan angka | `released=false` sampai run disetujui |
| **Menonaktifkan modul tidak menghapus data** | 32 punch / 9 hari / 3 shift / 2 persetujuan — identik sebelum, sesudah, dan setelah diaktifkan lagi. DoD Fase 6 |
| Modul nonaktif menolak API dengan 402, bukan 500 | `MODULE_NOT_SUBSCRIBED` pada seluruh endpointnya |
| Menu modul nonaktif hilang dari bootstrap | Tidak ada path `/attendance` maupun `/payroll` |
| Modul di luar paket tidak dapat diaktifkan | 402 dengan pesan menaikkan paket |
| Modul inti tidak dapat dinonaktifkan | 409 |
| Perubahan langganan berlaku tanpa login ulang | `refresh()` memuat ulang bootstrap |
| Kuota per tenant menggigit | 700 permintaan bersamaan → 100 ditolak 429 dengan `retry-after` |
| Kelebihan beban dibalas 503, bukan 500 | Banjir yang sama: 0 galat 500, 372 balasan 503 dengan `retry-after` |
| Batas waktu query berlaku per peran | `hrms_app` 15 dtk, `hrms_worker` 5 mnt, `hrms_platform` 30 dtk |
| Deteksi drift skema benar-benar mendeteksi | Tabel ber-`tenant_id` tanpa RLS dan RLS tanpa kebijakan keduanya tertangkap |
| Cakupan dasbor mengikuti izin, bukan parameter | HR menerima tiga cakupan; karyawan hanya `own`, sisanya `null` |
| Modul mati tidak menghasilkan angka palsu di dasbor | `payrollRunsPendingApproval: null`, bukan `0` |
| Pendaftaran mandiri tanpa menyentuh tim | Tenant baru terbuat, langsung dapat masuk, 14 hari uji coba, seluruh modul aktif |
| Kode perusahaan ganda ditolak | 409 dengan pesan yang menyebut kodenya |
| **Ekspor portabilitas UU PDP lengkap** | 23 tabel, 58 KB; ciphertext dan hash kata sandi TIDAK ikut |
| Ekspor menyertakan modul yang TIDAK dilanggan | Data payroll ikut meski modulnya nonaktif — portabilitas bukan fungsi langganan |
| **Pemulihan dari cadangan diuji, bukan hanya ditulis** | Cadangan 272 KB dipulihkan ke basis data baru: seluruh jumlah baris identik, 47 kebijakan RLS ikut, laporan drift 0 |
| Isolasi tenant utuh setelah pemulihan | Diuji sebagai `hrms_app`: tanpa konteks 0 baris, konteks demo 3 karyawan / 32 punch, konteks tenant lain 0 |
| Liveness dan readiness benar-benar berbeda | PostgreSQL dihentikan: `/api/health` tetap 200, `/api/ready` menjadi 503 dengan `retry-after` |
| Readiness pulih sendiri | Setelah PostgreSQL dinyalakan: `ready` 200 dalam 40 ms |
| **Pemulihan diukur pada ukuran nyata** | 160 MB / 261.000 ketukan: cadangan 2 detik, pemulihan 5 detik, 261.000 baris identik, drift 0 |
| Pemulihan berkas penyimpanan diuji | Hash SHA-256 identik, `storage_key` resolve ke path yang benar |
| **Log tidak membocorkan PII maupun token** | Galat yang membawa NIK, rekening, kata sandi, dan Bearer token: nol yang lolos; scope, correlationId, tenantId, dan kode galat tetap terbaca |
| Log terstruktur berjalan di proses nyata | Worker mengeluarkan JSON ber-`ts`/`level`/`scope` |
| **Jejak korelasi utuh lintas proses** | `x-correlation-id` dari HTTP → kolom `outbox.correlation_id` → log worker di proses berbeda, nilai identik |
| Cadangan terjadwal berjalan tanpa socket Docker | Layanan compose menghasilkan dump 62 tabel lewat jaringan; dipulihkan dengan drift RLS 0 |
| **Service worker tidak menyentuh jalur sensitif** | `sw.js` sungguhan dijalankan di VM: API, `/admin`, halaman kredensial, dan permintaan ber-`Authorization` seluruhnya dilewatkan |
| Uji service worker terbukti menangkap regresi | Uji mutasi: penjaga dihapus → uji gagal; dipulihkan → lulus |

---

## 4. Bug yang ditemukan lewat pengujian ujung-ke-ujung

Dicatat karena polanya berulang dan layak diketahui sebelum fase berikutnya:
**setiap satu dari bug ini gagal secara diam-diam.** Tidak satu pun menghasilkan
galat, dan seluruhnya akan lolos ke produksi tanpa uji ujung-ke-ujung.

1. **Batas hari kerja dihitung dalam UTC** — §2.1 di atas. Terparah.
2. **Path penyimpanan foto relatif terhadap direktori kerja proses** — `apps/web`
   menulis di satu tempat, job retensi mencari di tempat lain. Digabung dengan
   nomor 3, janji retensi 90 hari batal tanpa satu pun galat.
3. **`deletePhoto` menelan seluruh galat** — berkas tidak ditemukan dilaporkan
   sebagai berhasil dihapus.
4. **Topik event diterbitkan sebagai literal string** — `attendance.punch.flagged`
   tidak ada di katalog `EventTopic`, antreannya tidak pernah dibuat, dan setiap
   presensi bertanda mati setelah sepuluh percobaan. Kini tipenya `EventTopic`,
   sehingga literal di luar katalog tidak dapat dikompilasi.
5. **Topik tanpa konsumen** — dua topik menumpuk di `created` selamanya. Kini
   `Record<EventTopic, Consumer>` memaksa satu keputusan per topik saat kompilasi.
6. **Ketukan mesin absensi dinilai dengan ukuran ponsel** — tanpa lokasi dan
   tanpa foto berarti skor 50, di bawah ambang, sehingga SETIAP ketukan mesin
   masuk antrean tinjauan. Bagi tenant yang memakai mesin, antrean itu berisi
   seluruh presensinya.
7. **Tautan ekspor tidak dapat membawa token** — `<a href="/api/…">` diikuti
   peramban tanpa header `Authorization`, sehingga ekspor Excel dan unduh templat
   selalu 401. Fitur ekspor tidak pernah dapat dipakai dari UI.
8. **Nilai PII tersamar dapat tersimpan sebagai nilai sebenarnya** — grid
   mengunci kolomnya, tetapi jalur tulis yang sama dipakai impor, pembaruan
   massal, dan API langsung. Penjaganya dipindah ke batas tulis (P9).
9. **Entri manual HR masuk antrean tinjauan HR sendiri** — sekaligus menaikkan
   rasio bertanda, yaitu metrik yang dipakai mendeteksi ambang salah setel.
10. **`if()` pada formula gaji mengevaluasi kedua cabang** — formula bawaan
    sendiri yang menemukannya: `if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)`
    ditulis persis untuk menjaga terhadap pembagian nol, dan evaluasi penuh
    membuat penjaganya tidak pernah bekerja. Seluruh run gagal untuk setiap
    karyawan yang belum punya rekap presensi. Alasan semula — "formula gaji
    tidak punya efek samping" — melewatkan bahwa pembagian nol adalah galat,
    bukan efek samping.
11. **Penjaga variabel formula dapat dilewati lewat rantai prototipe** —
    `scope['__proto__']` mengembalikan `Object.prototype`, bukan `undefined`,
    sehingga pemeriksaan variabel-tidak-dikenal meloloskannya. Diperbaiki dengan
    `Object.hasOwn`. Penjaga yang dapat dilewati untuk satu nama tidak dapat
    dipercaya untuk nama lain.
12. **Menurunkan paket tidak mencabut akses modul** — entitlement hanya membaca
    `TenantModule.status`, tanpa memotongnya dengan modul yang termasuk paket.
    Tenant yang turun dari Basic ke Starter tetap memegang baris `payroll`
    berstatus ENABLED dari langganan sebelumnya dan terus memakai penggajian
    tanpa membayarnya. Tidak ada galat yang muncul — satu-satunya yang berubah
    adalah tagihannya. Diperbaiki: entitlement kini irisan paket dan status.
13. **Banjir permintaan menghasilkan 500, bukan 503** — 700 permintaan
    bersamaan menghabiskan pool transaksi, dan Prisma melempar "Unable to start
    a transaction in the given time" yang keluar sebagai 500. Salah dalam dua
    hal: klien dan proxy tidak mencoba ulang 500 (mereka mencoba ulang 503
    dengan `retry-after`), dan pemantauan galat mencatatnya sebagai bug padahal
    sistem berfungsi persis sebagaimana dirancang — ia sedang penuh. Kuota per
    menit membatasi LAJU, bukan KONKURENSI, dan yang menghabiskan pool adalah
    konkurensi.
14. **Aliran SSE memakai koneksi pemilik basis data** — `DATABASE_URL`
    terhubung sebagai `hrms_owner`, satu-satunya peran yang dapat menembus RLS
    dan tidak terikat `statement_timeout`. Setiap dasbor langsung yang dibuka
    memegang koneksi tanpa batas waktu dengan hak penuh, untuk pekerjaan yang
    hanya perlu mendengarkan satu kanal.
15. **Ekspor portabilitas melewatkan modul yang tidak dilanggan** — salah persis
    pada kasus yang paling penting: pelanggan yang menurunkan paketnya lalu
    ingin pindah sistem tidak menerima data penggajiannya. Datanya masih ada —
    modul nonaktif tidak menghapus apa pun — tetapi ia tidak dapat
    mengambilnya. Itu penguncian yang dibungkus kepatuhan, dan bertentangan
    dengan hak yang hendak dipenuhi ekspor itu sendiri.
16. **`BigInt` menjatuhkan seluruh ekspor** — `JSON.stringify` melempar "Do not
    know how to serialize a BigInt", dan galatnya menggagalkan SELURUH berkas,
    bukan satu kolomnya. Yang memakainya adalah kunci pada buku besar saldo
    cuti dan jejak akses — justru yang paling perlu ikut terbawa.
17. **Healthcheck kontainer menunjuk halaman klien** — `HEALTHCHECK` memanggil
    `/`, yang merender halaman React dan mengembalikan 200 meski basis datanya
    mati. Kontainer melaporkan sehat sementara aplikasinya tidak dapat melayani
    apa pun, dan orkestrator tidak punya alasan mengalihkan lalu lintas.
18. **Pemeriksa cakupan manifes buta terhadap `export function GET()`** — regex
    penemunya hanya mengenali `export const GET =`. Sebuah route yang ditulis
    dengan bentuk `function` adalah handler Next.js yang sah sepenuhnya, tetapi
    tidak terlihat oleh uji P7: ia melewati pendaftaran manifes, melewati
    pemeriksaan pembungkus `defineRoute`, dan bekerja sempurna saat diuji
    manual — tanpa memeriksa izin apa pun. Lubang pada penjaganya sendiri.
19. **Status `LEAVE` tidak pernah dihasilkan** — nilainya ada di tipe sejak awal,
    tetapi tidak ada satu pun jalur kode yang memproduksinya. Karyawan yang
    cutinya sudah disetujui manajernya tetap tercatat `ABSENT`, lalu dipotong
    gajinya sebagai mangkir. Kelas yang sama dengan nomor 4: nilai enum yang
    dideklarasikan tetapi tidak pernah diproduksi siapa pun.
20. **Antrean presensi luring tidak menyimpan pemiliknya** — antrean SENGAJA
    bertahan setelah logout (ia milik perangkat, bukan sesi; menghapusnya berarti
    membuang presensi orang yang baru keluar). Keputusan itu tetap benar. Yang
    salah adalah akibatnya: server menurunkan `employeeId` dari **sesi**, bukan
    dari isi ketukan. Pada perangkat bersama — ponsel gudang tiga shift, komputer
    pos satpam — A mengetuk saat jaringan mati, A keluar, B masuk, sinkronisasi
    berjalan, dan **ketukan A tercatat sebagai kehadiran B**. Presensi A lenyap;
    B menerima kehadiran yang tidak ia lakukan; keduanya baru terlihat saat slip
    gaji terbit. Kini `QueuedPunch.ownerUserId` wajib dan `flushQueue` menerima
    id pengguna yang sedang masuk. Ketukan milik orang lain **ditinggalkan**, tidak
    dibuang — pemiliknya mungkin masuk lagi di perangkat yang sama — dan
    dihitung terpisah (`otherUsers`) agar tidak muncul sebagai "3 belum terkirim"
    yang tidak akan pernah terkirim untuk yang sedang melihatnya. Diuji di
    `apps/web/test/offline-queue.test.ts`, termasuk uji bahwa ketukan orang lain
    TIDAK dihapus dan terkirim begitu pemiliknya masuk.
21. **Metode akrual cuti tidak pernah diproduksi siapa pun** — kelas yang sama
    dengan nomor 4 dan 19, dan yang ketiga kalinya. `AccrualMethod` punya lima
    nilai sejak migrasi pertama modul cuti dan HR dapat memilih kelimanya di
    layar jenis cuti, tetapi `ensureBalance` memberikan `defaultQuotaDays`
    **penuh apa pun metodenya**. Tenant yang memilih `MONTHLY_ACCRUAL`: karyawan
    yang masuk 10 Maret langsung menerima 12 hari, dapat mengambil seluruhnya di
    bulan April lalu mengundurkan diri di bulan Mei. Tenant yang memilih
    `ANNIVERSARY`: jatah yang menurut UU Ketenagakerjaan Pasal 79 ayat (3) baru
    timbul setelah 12 bulan bekerja terus-menerus sudah ada sejak 1 Januari bagi
    orang yang baru bekerja sebulan. Tidak ada galat pada keduanya; angkanya
    sekadar salah, dan salahnya berpihak pada karyawan sehingga tidak akan ada
    yang melaporkannya.
22. **Perbaikan nomor 21 nyaris memasang bug yang lebih buruk** — dicatat karena
    bentuknya lebih berharga daripada bug itu sendiri. Versi pertama
    `entitlementAsOf` memulangkan nol bila dinilai sebelum tahun periodenya
    mulai, untuk **semua** metode. Tetapi `runCarryOver` membuat baris tahun
    BERIKUTNYA, dan bila penutupan tahun dijalankan pada 31 Desember maka
    penilaiannya jatuh sebelum awal periode baru: seluruh perusahaan memulai
    tahun dengan jatah nol, dan karena `ANNUAL_GRANT` tidak tumbuh seiring waktu,
    tidak ada satu pun jalur yang akan memperbaikinya kemudian. Ditemukan saat
    menelusuri interaksinya dengan penutupan tahun, bukan oleh uji. Kini dijaga
    uji regresi yang diverifikasi lewat mutasi.

---

## 5. Yang masih terbuka

### Cadangan — batasnya

Prosedur cadangan dan pemulihan sudah **diuji dan terdokumentasi**
([runbook §6](../ops/RUNBOOK.md)), menutup butir DoD yang terbuka sejak F0.
Tiga batasnya perlu diketahui:

- **Belum ada PITR.** Kehilangan data maksimum = jarak antar-cadangan.
- **Berkas foto dan dokumen ikut dicadangkan** sebagai arsip terpisah
  berstempel waktu sama, dan pemulihannya sudah diuji sampai hash.
- **Belum diuji di atas 160 MB.** Angkanya linear pada rentang yang diuji,
  tetapi ekstrapolasi bukan pengukuran.
- **Pengarsipan puluhan ribu berkas kecil belum diukur** — `tar` atas banyak
  berkas kecil berperilaku berbeda dari `tar` atas satu berkas besar.
- **Diuji pada basis data ratusan kilobita.** Waktu pemulihan pada ukuran
  produksi belum diukur.

### Observabilitas

- **Log terstruktur** lewat `@hrms/observability`: level dari `LOG_LEVEL`,
  stempel waktu di dalam JSON, `correlationId`, dan **redaksi kunci sensitif**.
  43 titik `console.*` dimigrasikan; alat CLI sengaja tetap teks biasa karena
  dibaca orang di terminal, bukan dikumpulkan mesin.
- **Tipe `LogFields` mewajibkan `scope`.** Tiga titik log yang selama ini tanpa
  scope ketahuan saat kompilasi, bukan saat seseorang mencari di agregator.
- **Belum ada metrik.** Tidak ada endpoint Prometheus maupun penghitung
  permintaan; yang ada hanya log. Ditambahkan bila ada yang benar-benar
  mengumpulkannya.
- **Konteks permintaan HANYA untuk pencatatan.** Tenant sebagai dasar isolasi
  tetap diteruskan eksplisit ke `withTenant` — otorisasi yang membaca keadaan
  implisit dapat bocor lintas permintaan ketika satu `await` lupa ditunggu.
- **Korelasi mengalir lintas proses** lewat `AsyncLocalStorage` di batas
  permintaan, kolom `correlation_id` pada outbox, dan penerusan di konsumen
  worker. Header `x-correlation-id` dari luar dihormati, sehingga jejaknya
  dapat disambung dengan sistem hulu.
- **Belum ada tracing berspan** (OpenTelemetry). Yang ada korelasi id, bukan
  pohon span dengan durasi per lapisan. Ditambahkan bila ada yang benar-benar
  mengumpulkannya.

### Utang teknis

- **Backfill `work_date`** — baris `punch_logs` yang tercatat sebelum perbaikan
  zona waktu membawa tanggal kerja yang salah. Belum ada produksi, jadi belum
  di-backfill. **Wajib dijalankan sebelum rilis pertama** bila ada data yang
  dipertahankan.
- **Ambang rasio bertanda 12% belum terkalibrasi** — pengujian menghasilkan
  angka jauh di atas ambang karena presensi uji tanpa foto. Kalibrasi menuntut
  data pilot.
- **Retensi dokumen karyawan belum otomatis** — pengarsipan manual sudah ada,
  job berkala belum. Foto presensi sudah punya.
- **`attendance_policies` belum ada** — kebijakan `on_permission_denied`
  (`BLOCK` / `FALLBACK_ONLY`) pada dokumen `10` §114 belum dapat disetel tenant.
- **Aliran SSE belum diuji di balik proxy nyata** — `x-accel-buffering: no`
  sudah dipasang, tetapi belum diverifikasi terhadap nginx sungguhan.

### Cuti — yang belum ada

- **Persetujuan berjenjang** — §2.4 di atas.
- ~~**Akrual bulanan**~~ — **selesai.** Nomor 21 di atas.
  `MONTHLY_ACCRUAL` menabung 1/12 kuota pada setiap ulang-bulan tanggal masuk;
  `ANNIVERSARY` melahirkan kuota penuh pada ulang tahun masa kerja dan nol
  sebelumnya. Perhitungannya **fungsi murni atas tanggal masuk**
  (`entitlementAsOf`), bukan akumulasi — sehingga rekonsiliasinya idempoten dan
  memperbaiki diri sendiri: dijalankan dua kali sehari selisihnya nol, mati tiga
  bulan lalu menyala lagi ia mengejar seluruh ketertinggalannya dalam satu
  putaran. Direkonsiliasi di dua tempat: `ensureBalance` (setiap pengajuan cuti,
  supaya angka tidak pernah basi tepat saat dipakai) dan job harian worker
  (supaya layar saldo benar tanpa menunggu ada yang mengajukan).
  Diuji e2e terhadap basis data sungguhan: karyawan masuk 10 Maret memperoleh
  0 hari pada 1 April, 3 hari pada 10 Juni, 9 hari pada 31 Desember; pemanggilan
  kedua pada tanggal yang sama menambah **nol**; buku besar memuat kedua mutasi
  dengan catatan yang menjelaskan asal angkanya.
- **`ANNIVERSARY` bertabrakan dengan penutupan tahun kalender** — batas yang
  perlu diketahui, bukan bug. Baris saldo berkunci tahun kalender, sedangkan
  jatah `ANNIVERSARY` lahir di tengah tahun. Karyawan yang ulang tahun masa
  kerjanya bulan Juli kehilangan sisa cutinya pada 31 Desember dan tidak
  memperoleh jatah baru sampai Juli berikutnya. Tenant yang memakai metode ini
  **harus** menyetel `maxCarryOverDays` sebesar kuotanya. Periode saldo berbasis
  ulang tahun adalah perubahan skema, dan menunggu tenant nyata yang memakainya.
- **Lampiran cuti sebagai berkas** — `attachmentKey` saat ini teks bebas, belum
  terhubung ke penyimpanan dokumen yang sudah ada di modul karyawan.
- **Hari kerja selain Senin–Jumat** — pabrik enam hari dan ritel yang libur
  Senin dihitung salah oleh `countWorkingDays`.

### Payroll — yang belum ada

Seluruhnya terkunci Gerbang C, bukan tertinggal:

- **PPh21 skema TER, PTKP, perhitungan tahunan Desember**
- **BPJS Ketenagakerjaan (JHT, JP, JKK, JKM) dan Kesehatan** dengan batas upah
- **Prorata masuk/keluar tengah bulan** dan **lembur menurut Kepmenaker**
- **THR sebagai `run_type` terpisah** — enumnya ada, perhitungannya belum
- **Slip PDF** dan **ekspor bank** (BCA + Mandiri)
- **30 kasus uji regresi emas** yang dijalankan setiap commit

Yang tidak terkunci Gerbang C tetapi belum dibangun:

- **Perhitungan run di worker** — saat ini berjalan dalam request. Untuk 1.000
  karyawan (DoD: < 3 menit) ini harus pindah ke pg-boss, dan potongannya sudah
  disiapkan: `calculateRun` melewati slip yang sudah ada, sehingga dapat
  dilanjutkan setelah proses mati.
- **`statutory_configs` belum punya layar maupun endpoint** — tabelnya ada,
  pengisiannya menunggu Gerbang C.

### Komersialisasi — yang belum ada

- **Penagihan (Midtrans/Xendit)** — menuntut akun payment gateway beserta
  kredensialnya. Model langganan, invoice, dan dunning dapat dibangun tanpa
  akun, tetapi integrasinya tidak dapat diuji tanpa sandbox yang sungguhan.
- **Penagihan tetap satu-satunya yang belum ada.** Selebihnya — pendaftaran
  mandiri, uji coba 14 hari, aktivasi modul, dasbor, pengerasan, dan ekspor
  portabilitas — sudah berjalan dan terbukti.
- **Notifikasi berjenjang** email → Web Push → WhatsApp. Email sudah ada;
  Web Push dan WhatsApp belum.
- **Laporan siap pakai + ekspor `.xlsx` di seluruh modul** — baru modul karyawan
  yang punya ekspor.
- **Pengerasan F6 sudah selesai**: kuota per tenant (600/menit, dengan
  penolakan yang tercatat), `statement_timeout`/`lock_timeout`/
  `idle_in_transaction_session_timeout` per peran, deteksi drift skema harian
  lewat `public.schema_drift_report()`, dan [runbook lima insiden](../ops/RUNBOOK.md).

### DoD Fase 3 yang belum diverifikasi

Seluruhnya menuntut alat atau perangkat yang belum dipakai, bukan kode yang
belum ditulis:

- [ ] Lighthouse PWA 100, Performance ≥ 90 pada profil mobile
- [ ] Diuji pada Chromium dan WebKit, dan pada ≥2 perangkat fisik nyata
- [x] **Uji otomatis yang memastikan endpoint sensitif tidak masuk Cache Storage** —
      `apps/web/test/service-worker.test.ts` menjalankan `public/sw.js` yang
      sebenarnya di dalam konteks VM, bukan salinannya. Diverifikasi lewat uji
      mutasi: menghapus penjaga `NEVER_CACHE` menggagalkan 3 uji, menghapus
      penjaga `Authorization` menggagalkan 1.
- [ ] Verifikasi cache dan langganan push terhapus total saat logout, pada perangkat nyata

### Gerbang

- **Gerbang A** — tiga pilot mengimpor ≥100 karyawan secara mandiri. Belum diuji.
- **Gerbang B** — satu tenant membayar. Belum diuji.
- **Gerbang C** — ahli payroll terlibat + 30 kasus uji perhitungan disepakati.
  **Prasyarat keras F5**, belum dimulai.

Dengan F4 selesai, paket **"Basic tanpa payroll"** (Karyawan + Presensi + Cuti)
secara teknis siap dijual — tiga dari empat fitur Paket Basic referensi.
