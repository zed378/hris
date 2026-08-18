import Link from 'next/link';

/**
 * Halaman ini akan sering terlihat selama pengembangan bertahap.
 *
 * Menu dirender dari basis data dan sudah memuat rute Fase 2–5, sedangkan
 * halamannya menyusul fase demi fase. Mengosongkan menu sampai halamannya ada
 * akan menyembunyikan peta produk dari pengguna pilot; membiarkannya 404 polos
 * membuat sistem terasa rusak. Yang ini menjelaskan keadaan sebenarnya.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-5xl">🚧</p>
        <h1 className="mt-4 text-xl font-semibold">Halaman ini belum dibangun</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Modulnya sudah aktif untuk perusahaan Anda, tetapi tampilannya menyusul
          pada fase berikutnya.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md border border-slate-300 px-4 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Kembali ke beranda
        </Link>
      </div>
    </main>
  );
}
