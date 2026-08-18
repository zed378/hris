'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { TokenPasswordForm } from '@/components/token-password-form.tsx';

/**
 * Halaman yang dituju tautan pada email reset kata sandi.
 *
 * Publik menurut keperluannya — orang yang lupa kata sandi tidak dapat masuk
 * untuk mengganti kata sandinya.
 */
function ResetPasswordInner() {
  const token = useSearchParams().get('token');

  return (
    <TokenPasswordForm
      token={token}
      title="Atur ulang kata sandi"
      description="Pasang kata sandi baru untuk akun Anda. Tautan ini hanya dapat dipakai satu kali."
      submitLabel="Simpan kata sandi baru"
      passwordField="newPassword"
      endpoint="/api/auth/password/reset"
      successTitle="Kata sandi telah diganti"
      successBody={
        <>
          <p>Anda kini dapat masuk dengan kata sandi baru.</p>
          {/* Disebutkan karena akan terasa: pengguna yang sedang membuka aplikasi
              di ponsel akan mendapati dirinya keluar, dan tanpa penjelasan itu
              terlihat seperti kerusakan. */}
          <p className="mt-2">
            Demi keamanan, seluruh sesi Anda di perangkat lain telah diakhiri.
          </p>
        </>
      }
    />
  );
}

export default function ResetPasswordPage() {
  // `useSearchParams` menuntut batas Suspense. Tanpanya Next menolak membangun
  // halaman ini sebagai statis, dan kegagalannya muncul saat build — bukan saat
  // dijalankan.
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-400">Memuat…</div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
