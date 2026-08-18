'use client';

import { useEffect } from 'react';

/**
 * Registrasi service worker.
 *
 * Dipasang sebagai komponen, bukan skrip inline, supaya ia ikut terikat siklus
 * hidup React dan tidak berjalan pada render server.
 *
 * `admin.hrms.id` sengaja TIDAK memakai service worker sama sekali (dokumen 11
 * §1.1): control plane memakai CSP paling ketat dan tidak butuh mode luring,
 * sehingga service worker di sana hanya menambah permukaan serangan. Pemisahan
 * itu ditegakkan oleh cakupan — SW ini hanya didaftarkan dari layout tenant.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (window.location.pathname.startsWith('/admin')) return;

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Registrasi yang gagal bukan alasan untuk merusak aplikasi. Yang hilang
        // hanya kemampuan luring; seluruh fitur lain tetap berjalan.
      });
    };

    // Ditunda sampai halaman selesai memuat: registrasi service worker bersaing
    // dengan permintaan yang benar-benar dibutuhkan layar pertama.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
