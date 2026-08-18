'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TokenPasswordForm } from '@/components/token-password-form.tsx';

/**
 * Halaman yang dituju tautan pada email undangan.
 *
 * Berbeda dari reset kata sandi dalam satu hal yang penting: penerimanya belum
 * pernah masuk, sehingga ia belum tahu kode perusahaannya. Endpoint menerima
 * undangan mengembalikan kode itu, dan halaman ini menampilkannya kembali —
 * karena kode perusahaan adalah hal yang paling sering membuat orang gagal masuk
 * pada percobaan pertama.
 */
function AcceptInvitationInner() {
  const token = useSearchParams().get('token');
  const [account, setAccount] = useState<{ tenantCode: string; email: string } | null>(null);

  return (
    <TokenPasswordForm
      token={token}
      title="Selamat datang"
      description="Pasang kata sandi Anda untuk mulai memakai sistem HR perusahaan."
      submitLabel="Aktifkan akun"
      passwordField="password"
      endpoint="/api/auth/invitation/accept"
      onSuccess={(body) => setAccount(body as { tenantCode: string; email: string })}
      successTitle="Akun Anda aktif"
      successBody={
        <>
          <p>Simpan dua hal berikut — keduanya dibutuhkan setiap kali masuk:</p>
          <dl className="mt-3 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">Kode perusahaan</dt>
              <dd className="font-mono font-medium">{account?.tenantCode ?? '—'}</dd>
            </div>
            <div className="mt-1 flex justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">Email</dt>
              <dd className="font-medium">{account?.email ?? '—'}</dd>
            </div>
          </dl>
        </>
      }
    />
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-400">Memuat…</div>}>
      <AcceptInvitationInner />
    </Suspense>
  );
}
