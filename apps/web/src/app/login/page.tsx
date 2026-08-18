'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, useSession } from '@/lib/session.tsx';

export default function LoginPage() {
  const { status, login } = useSession();
  const router = useRouter();

  const [tenantCode, setTenantCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ tenantCode, email, password });
      router.replace('/');
    } catch (caught) {
      // Pesan galat sengaja diteruskan apa adanya dari server. Server sudah
      // menyamakan seluruh kegagalan kredensial menjadi satu pesan; menambah
      // tafsiran di sini berisiko mengembalikan perbedaan yang sengaja dihapus.
      setError(caught instanceof ApiError ? caught.message : 'Tidak dapat terhubung ke server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">HRMS</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Masuk ke akun perusahaan Anda
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <Field
            label="Kode perusahaan"
            hint="Diberikan saat perusahaan Anda mendaftar"
            value={tenantCode}
            onChange={setTenantCode}
            autoComplete="organization"
            placeholder="contoh: demo"
          />
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="username"
          />
          <Field
            label="Kata sandi"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />

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
            disabled={busy}
            className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? 'Memproses…' : 'Masuk'}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = 'text',
  autoComplete,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="ml-1 text-xs text-slate-400">({hint})</span>}
      <input
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-brand-700"
      />
    </label>
  );
}
