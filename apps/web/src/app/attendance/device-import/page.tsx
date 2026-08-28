'use client';

import { useCallback, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Impor ketukan dari mesin absensi (dokumen 10 §5).
 *
 * Layar ini dibangun mengelilingi satu kenyataan: berkas mesin absensi memakai
 * PIN, bukan nama. PIN yang tidak terdaftar tidak terlihat salah — ia hanya
 * tidak menghasilkan apa pun. HR akan mengimpor tiga ribu baris, melihat kata
 * "berhasil", dan tidak pernah tahu bahwa empat ratus di antaranya milik orang
 * yang PIN-nya belum dipetakan.
 *
 * Karena itu pratinjau bukan kenyamanan tambahan, melainkan langkah wajib, dan
 * daftar PIN tak dikenal ditampilkan paling menonjol — di atas angka berhasil.
 */

interface ImportIssue {
  rowNumber: number;
  raw: string;
  reason: string;
}

interface ImportResult {
  fileName: string;
  committed: boolean;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  insertedRows: number;
  unknownEmployees: string[];
  issues: ImportIssue[];
  headers: string[];
  range: { from: string; to: string } | null;
}

function tanggal(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DeviceImportPage() {
  const { api } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (commit: boolean) => {
      if (!file) return;
      setBusy(true);
      setError(null);

      const body = new FormData();
      body.set('file', file);
      body.set('commit', String(commit));

      const response = await api('/api/attendance/device-import', { method: 'POST', body });
      const json = (await response.json().catch(() => null)) as
        | (ImportResult & { error?: { message?: string } })
        | null;

      if (response.ok && json) {
        if (commit) setDone(json);
        else setPreview(json);
      } else {
        setError(json?.error?.message ?? 'Berkas tidak dapat diproses.');
      }
      setBusy(false);
    },
    [api, file],
  );

  const reset = useCallback(() => {
    setFile(null);
    setPreview(null);
    setDone(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const shown = done ?? preview;

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Impor Mesin Absensi</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Unggah berkas ekspor dari mesin fingerprint atau face recognition. Kolom
          dikenali otomatis — PIN, User ID, atau NIK untuk karyawan; DateTime, atau
          Tanggal dan Jam terpisah, untuk waktunya.
        </p>
      </header>

      <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setDone(null);
            setError(null);
          }}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void send(false)}
            disabled={!file || busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {busy && !done ? 'Memeriksa…' : 'Periksa berkas'}
          </button>

          {/* Tombol impor baru muncul setelah pratinjau. Bukan sekadar urutan
              yang rapi: yang dilihat HR sebelum menekannya adalah berapa PIN
              yang tidak dikenal, dan itu satu-satunya kesempatan menyadarinya. */}
          {preview && !done && (
            <button
              onClick={() => void send(true)}
              disabled={busy || preview.insertedRows === 0}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Mengimpor…' : `Impor ${preview.insertedRows.toLocaleString('id-ID')} ketukan`}
            </button>
          )}

          {(preview || done) && (
            <button
              onClick={reset}
              className="rounded-md px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              Mulai lagi
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}
      </section>

      {shown && (
        <>
          {done && (
            <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
              {done.insertedRows.toLocaleString('id-ID')} ketukan tersimpan
              {done.duplicateRows > 0 &&
                `, ${done.duplicateRows.toLocaleString('id-ID')} sudah ada sebelumnya dan dilewati`}
              . Rekap harian belum dihitung ulang — buka Rekap Kehadiran lalu jalankan
              hitung ulang pada tanggal yang terpengaruh.
            </p>
          )}

          {/* PIN tak dikenal ditampilkan PALING ATAS, di atas angka berhasil.
              Inilah satu-satunya kegagalan pada impor ini yang tidak menghasilkan
              galat apa pun — ketukannya sekadar tidak pernah masuk. */}
          {shown.unknownEmployees.length > 0 && (
            <section className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                {shown.unknownEmployees.length} nomor karyawan pada berkas tidak
                terdaftar. Ketukannya tidak akan diimpor.
              </p>
              <p className="mt-1 font-mono text-xs text-amber-800 dark:text-amber-300">
                {shown.unknownEmployees.slice(0, 40).join(', ')}
                {shown.unknownEmployees.length > 40 &&
                  ` … dan ${shown.unknownEmployees.length - 40} lainnya`}
              </p>
              <p className="mt-2 text-amber-800 dark:text-amber-300">
                Samakan nomor karyawan di HRIS dengan PIN di mesin, lalu unggah ulang.
              </p>
            </section>
          )}

          <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Baris di berkas', value: shown.totalRows },
              { label: 'Terpetakan ke karyawan', value: shown.validRows },
              { label: done ? 'Tersimpan' : 'Akan ditambahkan', value: shown.insertedRows },
              { label: 'Sudah ada sebelumnya', value: shown.duplicateRows },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <p className="text-xs text-slate-500 dark:text-slate-400">{stat.label}</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {stat.value.toLocaleString('id-ID')}
                </p>
              </div>
            ))}
          </section>

          <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
            <p className="text-slate-500 dark:text-slate-400">
              Kolom terbaca:{' '}
              <span className="font-mono text-xs">{shown.headers.join(' · ')}</span>
            </p>
            {shown.range && (
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                Rentang waktu: {tanggal(shown.range.from)} sampai {tanggal(shown.range.to)}
              </p>
            )}
          </section>

          {shown.issues.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <p className="border-b border-slate-200 px-4 py-2 text-sm font-medium dark:border-slate-800">
                Baris bermasalah
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {shown.issues.map((issue) => (
                    <tr
                      key={`${issue.rowNumber}-${issue.reason}`}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                    >
                      <td className="px-4 py-2 tabular-nums text-slate-400">
                        baris {issue.rowNumber}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {issue.raw}
                      </td>
                      <td className="px-4 py-2 text-amber-700 dark:text-amber-300">
                        {issue.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
