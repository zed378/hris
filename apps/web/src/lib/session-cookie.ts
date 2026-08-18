import type { NextResponse } from 'next/server';

/**
 * Refresh token disimpan sebagai cookie httpOnly, bukan dikembalikan ke JavaScript.
 *
 * PLAN/11 §5.3 melarang token menyentuh penyimpanan persisten — bukan hanya
 * `localStorage`, melainkan juga Cache Storage dan IndexedDB. Larangan itu sulit
 * ditegakkan bila token pernah berada di tangan JavaScript sama sekali: begitu
 * ia ada di sana, menyimpannya "sementara" agar sesi bertahan setelah refresh
 * halaman adalah hal paling wajar yang akan dilakukan seseorang.
 *
 * Cookie httpOnly menghapus pilihan itu. Skrip di halaman tidak dapat membacanya,
 * sehingga XSS pun tidak dapat mengekstraksi sesi jangka panjang. Yang tersisa di
 * memori hanyalah access token berumur 15 menit.
 *
 * Konsekuensi yang diterima: klien non-browser (skrip, uji, integrasi) harus ikut
 * memakai cookie jar. Itu satu baris `-c/-b` pada curl, dan harganya jauh lebih
 * murah daripada satu jalur yang membocorkan sesi.
 */

export const REFRESH_COOKIE = 'hrms_rt';

function refreshTtlDays(): number {
  return Number(process.env['REFRESH_TOKEN_TTL_DAYS'] ?? 30);
}

/**
 * Aman secara default; hanya dapat dimatikan secara eksplisit.
 *
 * Sengaja TIDAK diturunkan dari `NODE_ENV`. `next start` menyetel NODE_ENV ke
 * production, sehingga menguji build produksi di mesin sendiri lewat HTTP akan
 * selalu mematahkan sesi — browser membuang cookie `Secure` pada koneksi polos
 * di setiap hostname kecuali localhost. Gejalanya menyesatkan: login berhasil,
 * lalu muat ulang halaman mengembalikan pengguna ke layar masuk, tanpa satu pun
 * galat di sisi server.
 *
 * Arah defaultnya yang menentukan: lupa memasang variabel ini menghasilkan
 * cookie yang lebih aman, bukan yang kurang aman.
 */
function cookieSecure(): boolean {
  return process.env['COOKIE_SECURE'] !== 'false';
}

export function setRefreshCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: REFRESH_COOKIE,
    value: token,
    httpOnly: true,
    secure: cookieSecure(),
    // `strict`, bukan `lax`. Endpoint refresh mengubah keadaan (rotasi token),
    // dan `lax` masih mengirim cookie pada navigasi lintas situs.
    sameSite: 'strict',
    // Dibatasi ke jalur auth. Request ke /api/employees tidak perlu membawa
    // refresh token, dan yang tidak dikirim tidak dapat bocor.
    path: '/api/auth',
    maxAge: refreshTtlDays() * 86_400,
  });
}

export function clearRefreshCookie(response: NextResponse): void {
  response.cookies.set({
    name: REFRESH_COOKIE,
    value: '',
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 0,
  });
}

/** Membaca refresh token dari cookie request. */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}
