'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { downloadFile } from '@/lib/download.ts';

/**
 * Wizard impor karyawan dari Excel — Gerbang A (PLAN/12 Fase 2).
 *
 * Gerbangnya berbunyi: "tiga perusahaan pilot mengimpor ≥100 karyawan dari
 * berkas Excel mereka sendiri, dalam < 30 menit, **tanpa bantuan tim**."
 *
 * Kalimat terakhir yang menentukan bentuk layar ini. Setiap kali pengguna harus
 * bertanya, gerbangnya gagal — jadi yang ditampilkan bukan sekadar "berhasil"
 * atau "gagal", melainkan: kolom mana yang dikenali, kolom mana yang diabaikan,
 * baris mana yang bermasalah dan mengapa, serta apa yang akan terjadi bila
 * tombol simpan ditekan.
 */

interface ColumnMapping {
  mapping: Record<string, number>;
  unmapped: Array<{ index: number; header: string }>;
  missingRequired: string[];
}

interface Preview {
  jobId: string;
  fileName: string;
  sheetName: string;
  sheetCount: number;
  totalRows: number;
  validRows: number;
  errorRows: number;
  columns: ColumnMapping;
  sampleErrors: Array<{ rowNumber: number; name: string; errors: Array<{ field: string; message: string }> }>;
}

const FIELD_LABELS: Record<string, string> = {
  employeeNumber: 'Nomor Karyawan',
  fullName: 'Nama Lengkap',
  nationalId: 'NIK (KTP)',
  taxId: 'NPWP',
  email: 'Email',
  phone: 'Telepon',
  joinDate: 'Tanggal Masuk',
  birthDate: 'Tanggal Lahir',
  birthPlace: 'Tempat Lahir',
  gender: 'Jenis Kelamin',
  bankName: 'Nama Bank',
  bankAccount: 'Nomor Rekening',
  address: 'Alamat',
};

export default function ImportPage() {
  const { api } = useSession();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ committed: number; skipped: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setResult(null);

      const body = new FormData();
      body.append('file', file);

      const response = await api('/api/employees/import', { method: 'POST', body });
      const json = (await response.json().catch(() => null)) as
        | (Preview & { error?: { message: string } })
        | null;

      if (!response.ok) {
        setError(json?.error?.message ?? 'Berkas tidak dapat diproses');
        setPreview(null);
      } else {
        setPreview(json as Preview);
      }
      setBusy(false);
    },
    [api],
  );

  const commit = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);

    const response = await api(`/api/employees/import/${preview.jobId}/commit`, { method: 'POST' });
    const json = (await response.json().catch(() => null)) as
      | { committed: number; skipped: number; error?: { message: string } }
      | null;

    if (!response.ok) setError(json?.error?.message ?? 'Gagal menyimpan');
    else {
      setResult({ committed: json!.committed, skipped: json!.skipped });
      setPreview(null);
    }
    setBusy(false);
  }, [api, preview]);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold">Impor Karyawan dari Excel</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Unggah berkas Anda apa adanya. Judul kolom yang lazim dikenali otomatis —
            tidak perlu menyesuaikan berkas terlebih dahulu.
          </p>
        </header>

        {/* Langkah 1 — unggah */}
        {!preview && !result && (
          <section>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`rounded-xl border-2 border-dashed p-10 text-center transition ${
                dragging
                  ? 'border-brand-500 bg-brand-50 dark:bg-slate-800'
                  : 'border-slate-300 dark:border-slate-700'
              }`}
            >
              <p className="text-4xl">📄</p>
              <p className="mt-3 font-medium">Letakkan berkas .xlsx di sini</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">atau</p>

              <button
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? 'Memproses…' : 'Pilih berkas'}
              </button>

              <input
                ref={fileInput}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  // Direset supaya memilih berkas yang sama dua kali tetap memicu
                  // unggahan — hal yang pasti dilakukan orang setelah memperbaiki
                  // berkasnya di Excel tanpa mengganti namanya.
                  e.target.value = '';
                }}
              />
            </div>

            <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
              Belum punya berkas?{' '}
              {/* Tombol, bukan tautan: `<a href>` tidak membawa header
                  Authorization, dan endpointnya menjawab 401. */}
              <button
                onClick={() =>
                  void downloadFile(api, '/api/employees/template', 'templat-karyawan.xlsx')
                }
                className="text-brand-600 underline"
              >
                Unduh templat
              </button>{' '}
              berisi kolom yang dikenali dan dua baris contoh.
            </p>
          </section>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        )}

        {/* Langkah 2 — tinjau */}
        {preview && (
          <section className="space-y-5">
            <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm">
                <span className="font-medium">{preview.fileName}</span>
                {preview.sheetCount > 1 && (
                  <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    membaca sheet &ldquo;{preview.sheetName}&rdquo; dari {preview.sheetCount} sheet
                  </span>
                )}
              </p>

              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <Stat label="Baris terbaca" value={preview.totalRows} />
                <Stat label="Siap disimpan" value={preview.validRows} tone="good" />
                <Stat label="Perlu diperbaiki" value={preview.errorRows} tone="bad" />
              </div>
            </div>

            <details className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <summary className="cursor-pointer text-sm font-medium">
                Kolom yang dikenali ({Object.keys(preview.columns.mapping).length})
              </summary>
              <ul className="mt-3 grid grid-cols-2 gap-1 text-sm text-slate-600 dark:text-slate-300">
                {Object.keys(preview.columns.mapping).map((field) => (
                  <li key={field}>✓ {FIELD_LABELS[field] ?? field}</li>
                ))}
              </ul>

              {/* Kolom yang diabaikan ditampilkan menonjol, bukan disembunyikan.
                  Kolom yang tidak terbaca adalah data yang hilang diam-diam —
                  persis jenis kegagalan yang paling lama tidak disadari. */}
              {preview.columns.unmapped.length > 0 && (
                <div className="mt-4 rounded bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {preview.columns.unmapped.length} kolom tidak dikenali dan akan diabaikan:
                  </p>
                  <p className="mt-1 text-amber-800 dark:text-amber-300">
                    {preview.columns.unmapped.map((c) => c.header).join(', ')}
                  </p>
                </div>
              )}
            </details>

            {preview.errorRows > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <p className="text-sm font-medium">
                  Baris yang perlu diperbaiki
                  {preview.errorRows > preview.sampleErrors.length &&
                    ` (menampilkan ${preview.sampleErrors.length} dari ${preview.errorRows})`}
                </p>

                <table className="mt-3 w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-400">
                    <tr>
                      <th className="w-16 pb-2">Baris</th>
                      <th className="pb-2">Nama</th>
                      <th className="pb-2">Masalah</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {preview.sampleErrors.map((row) => (
                      <tr key={row.rowNumber} className="align-top">
                        <td className="py-2 font-mono text-xs text-slate-500">{row.rowNumber}</td>
                        <td className="py-2">{row.name || <span className="text-slate-400">—</span>}</td>
                        <td className="py-2 text-red-700 dark:text-red-300">
                          {/* Pesan identik ditampilkan sekali.
                              Satu berkas hasil ekspor tersamar memicu galat yang
                              sama pada NIK, NPWP, dan rekening sekaligus — tiga
                              kalimat yang sama berturut-turut membuat baris yang
                              sebenarnya sederhana terlihat rusak parah. */}
                          {[...new Set(row.errors.map((e) => e.message))].join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Perbaiki di Excel lalu unggah ulang. Baris yang sudah tersimpan akan
                  terdeteksi sebagai duplikat, sehingga tidak ada yang tergandakan.
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={() => void commit()}
                disabled={busy || preview.validRows === 0}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {busy
                  ? 'Menyimpan…'
                  : `Simpan ${preview.validRows} karyawan${
                      preview.errorRows > 0 ? ` (lewati ${preview.errorRows})` : ''
                    }`}
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setError(null);
                }}
                disabled={busy}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Batal
              </button>
            </div>
          </section>
        )}

        {/* Langkah 3 — hasil */}
        {result && (
          <section className="rounded-lg border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
            <p className="text-4xl">✅</p>
            <h2 className="mt-3 text-lg font-semibold">
              {result.committed} karyawan tersimpan
            </h2>
            {result.skipped > 0 && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {result.skipped} baris dilewati karena masih bermasalah. Perbaiki di Excel
                lalu unggah ulang berkasnya.
              </p>
            )}

            <div className="mt-5 flex justify-center gap-3">
              <button
                onClick={() => router.push('/employees')}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
              >
                Lihat daftar karyawan
              </button>
              <button
                onClick={() => setResult(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Impor berkas lain
              </button>
            </div>
          </section>
        )}

        <p className="mt-8 text-center text-xs text-slate-400">
          <Link href="/employees" className="underline">
            Kembali ke daftar karyawan
          </Link>
        </p>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'good' | 'bad';
}) {
  const color =
    tone === 'good' && value > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'bad' && value > 0
        ? 'text-red-600 dark:text-red-400'
        : 'text-slate-700 dark:text-slate-200';

  return (
    <div className="rounded-md bg-slate-50 py-3 dark:bg-slate-800/60">
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}
