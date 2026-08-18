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
  'GET /admin/api/overview': {},
} as const satisfies Record<string, AdminRouteRule>;

export const ADMIN_ROUTE_RULES: Readonly<Record<string, AdminRouteRule>> = ADMIN_ROUTE_MANIFEST;
