import type { ReactNode } from 'react';
import { AdminSessionProvider } from './admin-session.tsx';

export const metadata = {
  title: 'Control Plane',
  // Bidang admin tidak boleh terindeks, dan tidak boleh diikuti tautannya.
  robots: { index: false, follow: false },
};

/**
 * Kerangka bidang admin.
 *
 * **Bukan PWA, dan tidak berbagi apa pun dengan bidang tenant** (dokumen 11).
 * Tidak ada service worker, tidak ada manifest, tidak ada cache — halaman ini
 * memuat metadata seluruh pelanggan, dan satu salinannya yang tertinggal di
 * Cache Storage adalah daftar pelanggan yang tertinggal di laptop seseorang.
 *
 * `public/sw.js` sudah melewatkan seluruh jalur `/admin` tanpa menyentuhnya, dan
 * uji `service-worker.test.ts` menjaga sifat itu tetap benar.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminSessionProvider>{children}</AdminSessionProvider>;
}
