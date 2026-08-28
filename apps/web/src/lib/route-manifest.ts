/**
 * Peta route → modul → permission (PLAN/01 §5.2).
 *
 * Ini penegakan P7: **tidak ada route tanpa keputusan otorisasi eksplisit.**
 * Sebuah handler yang tidak terdaftar di sini tidak dapat dijangkau — bukan
 * karena lupa dilindungi, melainkan karena `defineRoute` menolak menjalankannya.
 *
 * Konsekuensi yang disengaja: menambah endpoint memaksa penulisnya menjawab dua
 * pertanyaan sebelum menulis satu baris logika — modul apa yang memilikinya, dan
 * permission apa yang menjaganya. Itu adalah pertanyaan yang paling mahal bila
 * baru ditanyakan setelah 200 route ada.
 *
 * Ada uji CI yang membandingkan berkas ini dengan berkas `route.ts` di disk;
 * salah satu tanpa pasangannya menggagalkan build.
 */

export interface RouteRule {
  /** Modul pemilik. Bila tenant tidak melanggan, request ditolak 402 (P8). */
  module: string;
  /** Permission yang dibutuhkan. `null` berarti cukup terautentikasi. */
  permission: string | null;
  /** Tanpa autentikasi sama sekali. Hanya untuk jalur masuk. */
  public?: boolean;
  /** Batas laju per IP untuk jalur publik yang dapat ditebak. */
  rateLimit?: { windowSeconds: number; max: number };
}

export type RouteId = keyof typeof ROUTE_MANIFEST;

export const ROUTE_MANIFEST = {
  // --- Jalur masuk: publik, tetapi dibatasi laju --------------------------------
  // Login sengaja dibatasi ketat. Tanpa itu, kunci akun per pengguna justru
  // menjadi senjata: penyerang dapat mengunci seluruh karyawan satu perusahaan
  // hanya dengan mengirim kata sandi salah delapan kali per akun.
  'POST /api/auth/login': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 300, max: 20 },
  },
  'POST /api/auth/refresh': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 60, max: 30 },
  },
  'POST /api/auth/logout': {
    module: 'core',
    permission: null,
    public: true,
  },

  // --- Pendaftaran mandiri ------------------------------------------------------
  // Dibatasi ketat: setiap panggilan membuat tenant, peran, dan pengguna. Tanpa
  // batas laju, endpoint ini adalah cara termurah untuk memenuhi basis data
  // dengan tenant sampah.
  'POST /api/tenants/register': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 3600, max: 5 },
  },

  // --- Reset kata sandi & undangan ----------------------------------------------
  // Ketiganya publik karena pemakainya, menurut definisi, belum dapat login.
  // Batas lajunya ketat: `forgot` mengirim email atas nama kita, dan endpoint
  // pengirim email tanpa batas adalah alat spam yang merusak reputasi domain.
  'POST /api/auth/password/forgot': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 10 },
  },
  'POST /api/auth/password/reset': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 20 },
  },
  'POST /api/auth/invitation/accept': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 20 },
  },

  // --- Pengguna, peran, dan hak akses khusus (PLAN/05 §7) ------------------------
  // Modul `iam` bersifat CORE, sehingga endpoint ini tidak pernah tertutup oleh
  // langganan — sebuah tenant harus selalu dapat mengelola penggunanya sendiri,
  // apa pun paketnya.
  'GET /api/users': { module: 'iam', permission: 'iam.user.read' },
  'POST /api/users': { module: 'iam', permission: 'iam.user.create' },
  'PUT /api/users/[id]/grants': { module: 'iam', permission: 'iam.grant.manage' },
  'DELETE /api/users/[id]/grants': { module: 'iam', permission: 'iam.grant.manage' },
  'GET /api/roles': { module: 'iam', permission: 'iam.role.read' },
  'PUT /api/roles/[id]/permissions': { module: 'iam', permission: 'iam.role.manage' },

  // --- Karyawan (Fase 2) --------------------------------------------------------
  // Modul `employee` bertier BASIC, sehingga endpoint ini menolak dengan 402 pada
  // tenant yang paketnya tidak mencakupnya — bahkan bagi TENANT_OWNER (P8).
  'GET /api/employees': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/employees': { module: 'employee', permission: 'employee.employee.create' },
  'GET /api/employees/[id]': { module: 'employee', permission: 'employee.employee.read.all' },
  'PATCH /api/employees/[id]': { module: 'employee', permission: 'employee.employee.update' },
  'PATCH /api/employees/bulk': { module: 'employee', permission: 'employee.employee.update' },
  'GET /api/employees/[id]/documents': {
    module: 'employee',
    permission: 'employee.document.read',
  },
  'POST /api/employees/[id]/documents': {
    module: 'employee',
    permission: 'employee.document.manage',
  },
  // Izin dasar yang dimiliki semua orang. Pemilahan pemilik-vs-HR terjadi di
  // dalam handler — tanpa itu, karyawan tidak dapat membuka pindaian KTP-nya
  // sendiri, yang justru hak yang dijamin UU PDP.
  'GET /api/documents/[docId]': { module: 'employee', permission: 'employee.employee.read.own' },
  'DELETE /api/documents/[docId]': {
    module: 'employee',
    permission: 'employee.document.manage',
  },

  // Impor Excel — jalur migrasi dari produk referensi, dan inti Gerbang A.
  // Templat memakai permission ekspor, bukan impor: mengunduh contoh kolom
  // adalah langkah pertama sebelum seseorang memutuskan akan mengimpor.
  'GET /api/employees/template': { module: 'employee', permission: 'employee.export.execute' },
  'GET /api/employees/export': { module: 'employee', permission: 'employee.export.execute' },

  // Kontrak kerja. Pengingat berakhirnya PKWT adalah alasan modul ini ditarik
  // maju ke Fase 2: satu kontrak yang lolos berubah menjadi PKWTT demi hukum,
  // dan itu tidak dapat dibatalkan (dokumen 08, A5).
  'GET /api/contracts/expiring': { module: 'employee', permission: 'employee.contract.read' },
  'POST /api/contracts': { module: 'employee', permission: 'employee.contract.manage' },
  'POST /api/employees/import': { module: 'employee', permission: 'employee.import.execute' },
  'GET /api/employees/import/[id]': { module: 'employee', permission: 'employee.import.execute' },
  'POST /api/employees/import/[id]/commit': { module: 'employee', permission: 'employee.import.execute' },

  // --- Struktur organisasi (Fase 2) ---------------------------------------------
  'GET /api/org/departments': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/org/departments': { module: 'employee', permission: 'employee.employee.update' },
  'GET /api/org/positions': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/org/positions': { module: 'employee', permission: 'employee.employee.update' },
  'POST /api/org/placements': { module: 'employee', permission: 'employee.employee.update' },

  // --- Presensi (Fase 3) --------------------------------------------------------
  // Mengetuk presensi memakai permission bercakupan `own`: karyawan hanya dapat
  // mengetuk untuk dirinya sendiri, dan `employeeId` diturunkan dari sesi — tidak
  // pernah dari badan request.
  'POST /api/attendance/punch': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'GET /api/attendance/me': { module: 'attendance', permission: 'attendance.record.read.own' },

  // Unggah foto memakai izin presensi sendiri; penyajiannya memeriksa lapisan
  // kedua di dalam handler — karyawan biasa hanya boleh melihat fotonya sendiri.
  'POST /api/attendance/photo': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'GET /api/attendance/photo/[key]': { module: 'attendance', permission: 'attendance.record.read.own' },

  // Antrean tinjauan. Presensi bertanda TIDAK ditolak otomatis — ia menunggu
  // keputusan manusia yang mengenal konteksnya (P14).
  'GET /api/attendance/review': { module: 'attendance', permission: 'attendance.review.handle' },
  'POST /api/attendance/review': { module: 'attendance', permission: 'attendance.review.handle' },

  // Persetujuan hanya dapat diberikan untuk diri sendiri, jadi izinnya adalah
  // izin presensi dasar — bukan izin administratif. HR tidak punya jalur untuk
  // menyetujui atas nama siapa pun, dan itu memang inti aturannya.
  // Cakupan dasbor ditentukan izin di dalam handler, bukan oleh parameter.
  // Izin di manifes karenanya izin dasar yang dimiliki semua orang.
  'GET /api/dashboard': { module: 'core', permission: 'core.dashboard.view.own' },

  // --- Kesehatan -------------------------------------------------------------
  //
  // Keduanya TIDAK memakai defineRoute — lihat berkas rutenya. Didaftarkan di
  // sini semata supaya pemeriksaan cakupan manifes tidak melaporkannya sebagai
  // rute yang tidak terdaftar (P7).
  'GET /api/health': { module: 'core', permission: null, public: true },
  'GET /api/ready': { module: 'core', permission: null, public: true },

  // --- Langganan -------------------------------------------------------------
  //
  // Modulnya `core`, bukan modul yang sedang diatur. Endpoint yang mengatur
  // langganan tidak boleh ikut mati ketika modul yang diaturnya dinonaktifkan.
  'GET /api/subscription': { module: 'core', permission: 'core.settings.manage' },
  // Ekspor seluruh data tenant — portabilitas UU PDP.
  //
  // Batas lajunya ketat: satu ekspor lengkap membaca setiap tabel milik tenant,
  // dan tombol yang ditekan berulang kali karena berkasnya lama muncul akan
  // menjalankan seluruh pembacaan itu berkali-kali sekaligus.
  'GET /api/tenant/export': {
    module: 'core',
    permission: 'core.settings.manage',
    rateLimit: { windowSeconds: 3600, max: 5 },
  },
  'POST /api/subscription': { module: 'core', permission: 'core.settings.manage' },

  // --- Penggajian ------------------------------------------------------------
  'GET /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },
  'POST /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },
  // PUT memeriksa formula tanpa menyimpannya, dipakai layar konfigurasi saat
  // admin mengetik. Izinnya sama dengan menyimpan: yang boleh mengetahui
  // variabel apa saja yang tersedia adalah yang boleh mengonfigurasinya.
  'PUT /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },

  'GET /api/payroll/salary': { module: 'payroll', permission: 'payroll.salary.read' },
  'POST /api/payroll/salary': { module: 'payroll', permission: 'payroll.salary.manage' },

  'GET /api/payroll/runs': { module: 'payroll', permission: 'payroll.run.execute' },
  'POST /api/payroll/runs': { module: 'payroll', permission: 'payroll.run.execute' },
  'GET /api/payroll/runs/[id]': { module: 'payroll', permission: 'payroll.run.execute' },
  // Persetujuan diperiksa di dalam handler dengan izin terpisah: orang yang
  // menghitung dan orang yang menyetujui sebaiknya berbeda.
  'POST /api/payroll/runs/[id]': { module: 'payroll', permission: 'payroll.run.execute' },

  // Izin dasar yang dimiliki semua orang; pemilahan sendiri-vs-semua terjadi di
  // dalam handler. Tanpa itu, karyawan tidak dapat melihat slip gajinya sendiri.
  'GET /api/payroll/payslips': { module: 'payroll', permission: 'payroll.payslip.read.own' },

  // --- Cuti ------------------------------------------------------------------
  'GET /api/leave/types': { module: 'leave', permission: 'leave.request.create.own' },
  'POST /api/leave/types': { module: 'leave', permission: 'leave.policy.manage' },
  // Cakupan daftar ditentukan izin di dalam handler, bukan oleh parameter:
  // klien yang meminta `all` tanpa izin menerima daftarnya sendiri, bukan galat.
  'GET /api/leave/requests': { module: 'leave', permission: 'leave.request.read.own' },
  'POST /api/leave/requests': { module: 'leave', permission: 'leave.request.create.own' },
  'POST /api/leave/requests/[id]/decision': {
    module: 'leave',
    permission: 'leave.request.approve',
  },
  'DELETE /api/leave/requests/[id]/decision': {
    module: 'leave',
    permission: 'leave.request.create.own',
  },
  'GET /api/leave/balances': { module: 'leave', permission: 'leave.balance.read.own' },
  'POST /api/leave/balances': { module: 'leave', permission: 'leave.balance.manage' },

  'GET /api/attendance/live': { module: 'attendance', permission: 'attendance.record.read.all' },
  'GET /api/attendance/consent': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'POST /api/attendance/consent': {
    module: 'attendance',
    permission: 'attendance.punch.create.own',
  },
  'POST /api/attendance/device-import': {
    module: 'attendance',
    permission: 'attendance.record.correct',
  },
  'POST /api/attendance/manual-punch': {
    module: 'attendance',
    permission: 'attendance.record.correct',
  },
  'GET /api/attendance/records': { module: 'attendance', permission: 'attendance.record.read.all' },
  'POST /api/attendance/records': { module: 'attendance', permission: 'attendance.record.correct' },
  'GET /api/attendance/work-sites': { module: 'attendance', permission: 'attendance.record.read.own' },
  'POST /api/attendance/work-sites': { module: 'attendance', permission: 'attendance.shift.manage' },
  'GET /api/attendance/holidays': {
    module: 'attendance',
    // Semua orang perlu melihatnya: kalender cuti menampilkannya, dan karyawan
    // yang mengajukan cuti perlu tahu tanggal mana yang tidak memotong saldo.
    permission: 'attendance.record.read.own',
  },
  'POST /api/attendance/holidays': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'DELETE /api/attendance/holidays': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'GET /api/attendance/schedules': {
    module: 'attendance',
    permission: 'attendance.record.read.own',
  },
  'POST /api/attendance/schedules': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'GET /api/attendance/shifts': { module: 'attendance', permission: 'attendance.record.read.own' },
  'POST /api/attendance/shifts': { module: 'attendance', permission: 'attendance.shift.manage' },

  // --- Bootstrap ----------------------------------------------------------------
  // Tidak memerlukan permission: setiap pengguna terautentikasi berhak tahu apa
  // yang boleh ia lihat. Isinya sendiri sudah tersaring akses efektif.
  'GET /api/me/bootstrap': {
    module: 'core',
    permission: null,
  },
} as const satisfies Record<string, RouteRule>;

export function lookupRoute(method: string, pathname: string): RouteRule | undefined {
  return ROUTE_MANIFEST[`${method} ${pathname}` as RouteId];
}

/**
 * Tampilan bertipe lebar dari manifest yang sama.
 *
 * `as const satisfies` di atas memberi kunci bertipe literal — itulah yang
 * membuat `defineRoute('GET /api/typo')` gagal dikompilasi. Efek sampingnya,
 * properti opsional seperti `rateLimit` hanya muncul pada anggota union yang
 * memilikinya, sehingga iterasi generik atas manifest tidak dapat mengaksesnya.
 *
 * Dua bentuk, satu sumber: kode yang menyebut satu route memakai `ROUTE_MANIFEST`
 * (aman terhadap salah ketik), kode yang mengiterasi seluruh route memakai
 * `ROUTE_RULES`.
 */
export const ROUTE_RULES: Readonly<Record<string, RouteRule>> = ROUTE_MANIFEST;

/**
 * Manifest control plane.
 *
 * Terpisah dari `ROUTE_MANIFEST` dan tidak punya kolom `module` maupun
 * `permission`: bidang admin tidak mengenal langganan, dan perannya belum
 * berjenjang. Menyatukan keduanya dalam satu tabel akan menggoda seseorang untuk
 * memakai `defineRoute` pada jalur admin — dan pada saat itu token tenant menjadi
 * kunci ke control plane.
 */
export interface AdminRouteRule {
  public?: boolean;
  rateLimit?: { windowSeconds: number; max: number };
}

export type AdminRouteId = keyof typeof ADMIN_ROUTE_MANIFEST;

export const ADMIN_ROUTE_MANIFEST = {
  'POST /admin/api/auth/login': {
    public: true,
    // Lebih ketat daripada login tenant. Satu akun di sini memegang metadata
    // seluruh pelanggan, dan jumlah akunnya dapat dihitung dengan jari.
    rateLimit: { windowSeconds: 900, max: 10 },
  },
  'GET /admin/api/tenants': {},
  'POST /admin/api/tenants': {},
  'POST /admin/api/tenants/status': {},
  'GET /admin/api/overview': {},
} as const satisfies Record<string, AdminRouteRule>;

export const ADMIN_ROUTE_RULES: Readonly<Record<string, AdminRouteRule>> = ADMIN_ROUTE_MANIFEST;
