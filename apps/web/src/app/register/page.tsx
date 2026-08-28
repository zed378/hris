'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Pendaftaran mandiri (PLAN/12 F6).
 *
 * Halaman ini adalah DoD Fase 6 pada titik paling awalnya: **pelanggan dapat
 * mendaftar tanpa menyentuh tim.** Sampai halaman ini ada, setiap tenant baru
 * menuntut seseorang menjalankan sesuatu secara manual.
 *
 * Empat keputusan yang menentukan apakah orang benar-benar menyelesaikannya:
 *
 *   1. **Satu layar, bukan wizard.** Lima kolom tidak memerlukan tiga langkah,
 *      dan setiap langkah tambahan adalah tempat orang berhenti.
 *   2. **Kode perusahaan dibangkitkan dari namanya**, dapat disunting. Ia
 *      menjadi bagian identitas login selamanya dan tidak dapat diubah setelah
 *      dibuat — tetapi memintanya sebagai isian kosong akan membuat orang
 *      mengetik sesuatu yang ia sesali.
 *   3. **Syarat kata sandi ditampilkan sebelum ditolak**, bukan sesudah.
 *   4. **Yang didapat dinyatakan lebih dulu**: 14 hari, seluruh modul, tanpa
 *      kartu kredit. Pendaftaran yang menyembunyikan itu terbaca seperti jebakan.
 */

const FIELD =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

/**
 * Mengubah nama perusahaan menjadi kode yang sah.
 *
 * "PT Maju Bersama Sejahtera" → "maju-bersama-sejahtera". Bentuk badan usaha
 * dibuang karena hampir setiap perusahaan Indonesia memilikinya, dan kode yang
 * seluruhnya diawali "pt-" tidak membedakan apa pun.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(pt|cv|ud|pt\.|cv\.)\s+/i, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export default function RegisterPage() {
  const router = useRouter();

  const [form, setForm] = useState({
    companyName: '',
    tenantCode: '',
    ownerFullName: '',
    ownerEmail: '',
    ownerPassword: '',
  });
  // Kode berhenti mengikuti nama begitu pengguna menyuntingnya sendiri.
  const [codeEdited, setCodeEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [done, setDone] = useState<{ tenantCode: string; trialEndsAt: string | null } | null>(
    null,
  );

  const setCompanyName = useCallback(
    (value: string) => {
      setForm((f) => ({
        ...f,
        companyName: value,
        tenantCode: codeEdited ? f.tenantCode : slugify(value),
      }));
    },
    [codeEdited],
  );

  const passwordChecks = useMemo(() => {
    const p = form.ownerPassword;
    return [
      { label: 'Minimal 12 karakter', ok: p.length >= 12 },
      { label: 'Ada huruf besar dan kecil', ok: /[a-z]/.test(p) && /[A-Z]/.test(p) },
      { label: 'Ada angka', ok: /[0-9]/.test(p) },
    ];
  }, [form.ownerPassword]);

  const canSubmit =
    form.companyName.trim().length >= 2 &&
    /^[a-z0-9-]{3,32}$/.test(form.tenantCode) &&
    form.ownerFullName.trim().length >= 2 &&
    form.ownerEmail.includes('@') &&
    passwordChecks.every((check) => check.ok) &&
    !busy;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const response = await fetch('/api/tenants/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });

    const json = (await response.json().catch(() => null)) as {
      tenantCode?: string;
      trialEndsAt?: string | null;
      error?: { message?: string; details?: Record<string, string[]> };
    } | null;

    if (response.ok && json) {
      setDone({ tenantCode: json.tenantCode ?? form.tenantCode, trialEndsAt: json.trialEndsAt ?? null });
    } else {
      setError(json?.error?.message ?? 'Pendaftaran gagal. Coba lagi sebentar lagi.');
      setFieldErrors(json?.error?.details ?? {});
    }

    setBusy(false);
  }, [form]);

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-6 dark:border-emerald-800 dark:bg-emerald-950/40">
          <h1 className="text-lg font-semibold text-emerald-900 dark:text-emerald-200">
            Perusahaan Anda siap
          </h1>
          <p className="mt-2 text-sm text-emerald-900 dark:text-emerald-200">
            Masuk dengan kode perusahaan <strong>{done.tenantCode}</strong> dan email
            yang baru Anda daftarkan.
          </p>
          {done.trialEndsAt && (
            <p className="mt-2 text-sm text-emerald-900 dark:text-emerald-200">
              Uji coba berlaku sampai{' '}
              {new Date(done.trialEndsAt).toLocaleDateString('id-ID', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              . Data Anda tidak dihapus setelah masa itu berakhir.
            </p>
          )}
        </div>

        <button
          onClick={() => router.push('/login')}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          Masuk sekarang
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Daftarkan perusahaan Anda</h1>
        {/* Dinyatakan lebih dulu. Pendaftaran yang menyembunyikan apa yang
            didapat terbaca seperti jebakan. */}
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Gratis 14 hari dengan seluruh modul aktif — karyawan, presensi, cuti,
          dan penggajian. Tanpa kartu kredit.
        </p>
      </header>

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Nama perusahaan</span>
          <input
            value={form.companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="PT Maju Bersama Sejahtera"
            className={FIELD}
            autoComplete="organization"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Kode perusahaan</span>
          <input
            value={form.tenantCode}
            onChange={(e) => {
              setCodeEdited(true);
              setForm((f) => ({ ...f, tenantCode: e.target.value.toLowerCase() }));
            }}
            placeholder="maju-bersama"
            className={`${FIELD} font-mono`}
          />
          {/* Peringatan permanen ditulis sebelum orang mengetik, bukan setelah
              ia menekan daftar. */}
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Dipakai setiap kali karyawan Anda masuk, dan{' '}
            <strong>tidak dapat diubah</strong> setelah perusahaan dibuat.
          </span>
          {fieldErrors['tenantCode'] && (
            <span className="mt-1 block text-xs text-red-600">
              {fieldErrors['tenantCode'].join(', ')}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Nama Anda</span>
          <input
            value={form.ownerFullName}
            onChange={(e) => setForm((f) => ({ ...f, ownerFullName: e.target.value }))}
            className={FIELD}
            autoComplete="name"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Email Anda</span>
          <input
            type="email"
            value={form.ownerEmail}
            onChange={(e) => setForm((f) => ({ ...f, ownerEmail: e.target.value }))}
            className={FIELD}
            autoComplete="email"
          />
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Akun ini menjadi pemilik perusahaan dengan akses penuh.
          </span>
          {fieldErrors['ownerEmail'] && (
            <span className="mt-1 block text-xs text-red-600">
              {fieldErrors['ownerEmail'].join(', ')}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Kata sandi</span>
          <input
            type="password"
            value={form.ownerPassword}
            onChange={(e) => setForm((f) => ({ ...f, ownerPassword: e.target.value }))}
            className={FIELD}
            autoComplete="new-password"
          />
          {/* Syaratnya ditampilkan sambil mengetik, bukan sebagai penolakan
              setelah menekan tombol. */}
          <ul className="mt-2 space-y-0.5">
            {passwordChecks.map((check) => (
              <li
                key={check.label}
                className={`text-xs ${
                  check.ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {check.ok ? '✓' : '·'} {check.label}
              </li>
            ))}
          </ul>
        </label>
      </div>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="mt-6 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? 'Menyiapkan perusahaan Anda…' : 'Mulai uji coba 14 hari'}
      </button>

      <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
        Sudah punya akun?{' '}
        <Link href="/login" className="text-brand-600 underline">
          Masuk
        </Link>
      </p>
    </main>
  );
}
