'use client';

import { useState, type FormEvent, type ReactNode } from 'react';

/**
 * Formulir pemasangan kata sandi lewat token.
 *
 * Dipakai dua alur yang secara visual identik tetapi berbeda arti: menerima
 * undangan (belum pernah punya kata sandi) dan mengatur ulang (punya, tapi lupa).
 * Perbedaannya hanya pada teks dan endpoint, sehingga formulirnya satu.
 *
 * Halaman ini publik — pemakainya menurut definisi belum dapat masuk. Yang
 * menjaganya adalah token di URL, dan token itu sekali pakai serta berumur
 * pendek.
 */

const MIN_LENGTH = 12;

export interface TokenPasswordFormProps {
  title: string;
  description: string;
  submitLabel: string;
  /** Nama field kata sandi yang diharapkan endpoint. Keduanya berbeda. */
  passwordField: 'password' | 'newPassword';
  endpoint: string;
  successTitle: string;
  successBody: ReactNode;
  onSuccess?: (body: unknown) => void;
}

export function TokenPasswordForm(props: TokenPasswordFormProps & { token: string | null }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Token yang tidak ada ditangani sebelum formulir dirender. Menampilkan
  // formulir yang pasti gagal saat dikirim membuang waktu pengguna dan
  // menyembunyikan penyebab sesungguhnya: tautannya terpotong saat disalin.
  if (!props.token) {
    return (
      <Frame title="Tautan tidak lengkap">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Tautan yang Anda buka tidak memuat kode verifikasi. Ini biasanya terjadi
          ketika tautan terpotong saat disalin dari email.
        </p>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          Buka kembali tautan dari email Anda secara utuh, atau minta tautan baru.
        </p>
        <a href="/login" className="mt-5 inline-block text-sm text-brand-600 underline">
          Kembali ke halaman masuk
        </a>
      </Frame>
    );
  }

  if (done) {
    return (
      <Frame title={props.successTitle}>
        <div className="text-sm text-slate-600 dark:text-slate-300">{props.successBody}</div>
        <a
          href="/login"
          className="mt-5 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          Lanjut ke halaman masuk
        </a>
      </Frame>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= MIN_LENGTH && password === confirm;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch(props.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: props.token, [props.passwordField]: password }),
    });

    if (response.ok) {
      const body = response.status === 204 ? null : await response.json().catch(() => null);

      // Sesi apa pun yang masih tertinggal di peramban ini dibersihkan.
      //
      // Orang yang membuka tautan undangan atau reset kata sandi belum tentu
      // orang yang terakhir memakai peramban ini — komputer bersama di ruang HR
      // adalah kasus yang biasa, bukan pengecualian. Tanpa langkah ini, menekan
      // "lanjut ke halaman masuk" membawanya ke dashboard milik orang lain,
      // lengkap dengan datanya.
      //
      // Cookie sesi bersifat httpOnly, sehingga hanya server yang dapat
      // menghapusnya.
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(
        () => undefined,
      );

      props.onSuccess?.(body);
      setDone(true);
    } else {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? 'Tautan tidak sah atau sudah kedaluwarsa');
    }
    setBusy(false);
  }

  return (
    <Frame title={props.title}>
      <p className="text-sm text-slate-500 dark:text-slate-400">{props.description}</p>

      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Kata sandi baru</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950"
          />
          {/* Panjang minimum satu-satunya syarat, dan itu disengaja. Aturan
              "wajib satu huruf besar dan satu simbol" menghasilkan Password1! —
              panjang adalah satu-satunya syarat yang benar-benar berkorelasi
              dengan ketahanan. */}
          <span
            className={`mt-1 block text-xs ${
              tooShort ? 'text-red-600 dark:text-red-400' : 'text-slate-400'
            }`}
          >
            Minimal {MIN_LENGTH} karakter
            {password.length > 0 && ` — saat ini ${password.length}`}
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Ulangi kata sandi</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950"
          />
          {mismatch && (
            <span className="mt-1 block text-xs text-red-600 dark:text-red-400">
              Kedua kata sandi belum sama
            </span>
          )}
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !ready}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Menyimpan…' : props.submitLabel}
        </button>
      </form>
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-2xl font-semibold tracking-tight">HRMS</p>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">{title}</h1>
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </main>
  );
}
