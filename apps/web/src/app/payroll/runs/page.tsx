'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { downloadFile, type DownloadOutcome } from '@/lib/download.ts';

/**
 * Proses penggajian (PLAN/12 F5).
 *
 * Dua hal yang dinyatakan terus terang di layar ini, karena keduanya menentukan
 * apakah HR berani memakainya:
 *
 *   1. **Modul ini belum menghitung PPh21 dan BPJS.** Dikatakan di atas, bukan
 *      disembunyikan. HR yang mengira pajaknya sudah dihitung akan membayarkan
 *      gaji yang kurang potong, dan yang menanggung akibatnya perusahaannya.
 *   2. **Karyawan yang gagal dihitung disebut namanya**, bukan diringkas
 *      menjadi "3 gagal". Ringkasan tanpa nama memaksa HR menebak.
 */

interface Run {
  id: string;
  runNumber: string;
  runType: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  lastError: string | null;
}

interface RunDetail {
  run: Run & { totalDeduction: number };
  payslips: Array<{
    id: string;
    employee: { employeeNumber: string; fullName: string } | null;
    gross: number;
    deduction: number;
    net: number;
  }>;
}

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  CALCULATING: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  CALCULATED: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  PAID: 'bg-emerald-600 text-white dark:bg-emerald-700',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  CANCELLED: 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

const rupiah = (value: number): string =>
  new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(value);

export default function PayrollRunsPage() {
  const { api, can } = useSession();
  const [unduhan, setUnduhan] = useState<DownloadOutcome | null>(null);
  const [unduhBusy, setUnduhBusy] = useState(false);

  const unduh = useCallback(
    async (path: string, nama: string) => {
      setUnduhBusy(true);
      setUnduhan(await downloadFile(api, path, nama));
      setUnduhBusy(false);
    },
    [api],
  );
  const canApprove = can('payroll.run.approve');

  const now = new Date();
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [form, setForm] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await api('/api/payroll/runs');
    if (response.ok) setRuns(((await response.json()) as { runs: Run[] }).runs);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);



  const openRun = useCallback(
    async (id: string) => {
      const response = await api(`/api/payroll/runs/${id}`);
      if (response.ok) setDetail((await response.json()) as RunDetail);
    },
    [api],
  );

  /**
   * Memuat ulang selama masih ada run yang dihitung.
   *
   * Perhitungan kini berjalan di worker, sehingga halaman tidak lagi menunggu
   * jawabannya. Tanpa polling, HR menekan "Hitung", melihat status berubah
   * menjadi CALCULATING, lalu tidak melihat apa-apa lagi — dan menyimpulkan
   * sistemnya menggantung. Interval berhenti sendiri begitu tidak ada lagi run
   * yang berjalan; tidak ada polling yang tertinggal menyala di tab yang dibuka
   * semalaman.
   */
  const adaYangDihitung = runs.some((run) => run.status === 'CALCULATING');

  useEffect(() => {
    if (!adaYangDihitung) return;

    const timer = setInterval(() => {
      void load();
      setDetail((current) => {
        if (current) void openRun(current.run.id);
        return current;
      });
    }, 3_000);

    return () => clearInterval(timer);
  }, [adaYangDihitung, load, openRun]);

  const act = useCallback(
    async (runId: string, body: unknown, sukses: string) => {
      setBusy(true);
      setMessage(null);

      const response = await api(`/api/payroll/runs/${runId}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; failures?: Array<{ employeeId: string; reason: string }> }
        | null;

      if (response.ok) {
        // Kegagalan per karyawan disebut alasannya, bukan diringkas menjadi
        // "3 gagal". Ringkasan tanpa alasan memaksa HR menebak apa yang salah.
        const gagal = json?.failures ?? [];
        setMessage({
          tone: gagal.length > 0 ? 'error' : 'ok',
          text:
            gagal.length > 0
              ? `${sukses}, tetapi ${gagal.length} karyawan gagal: ${gagal[0]?.reason ?? ''}`
              : sukses,
        });
      } else {
        setMessage({ tone: 'error', text: json?.error?.message ?? 'Operasi gagal.' });
      }

      setBusy(false);
      void load();
      // Rincian yang sedang terbuka dimuat ulang, supaya angkanya tidak
      // tertinggal satu langkah dari kenyataan setelah run dihitung ulang.
      setDetail((current) => {
        if (current) void openRun(current.run.id);
        return current;
      });
    },
    [api, load, openRun],
  );

  const createRun = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const response = await api('/api/payroll/runs', {
      method: 'POST',
      body: JSON.stringify({ periodYear: form.year, periodMonth: form.month, runType: 'MONTHLY' }),
    });
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    setMessage(
      response.ok
        ? { tone: 'ok', text: 'Run dibuat. Tekan Hitung untuk memprosesnya.' }
        : { tone: 'error', text: json?.error?.message ?? 'Run gagal dibuat.' },
    );
    setBusy(false);
    void load();
  }, [api, form, load]);

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Proses Penggajian</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Satu run per periode. Menghitung ulang run yang terputus melanjutkan
          dari tempat ia berhenti, tanpa menggandakan slip.
        </p>
      </header>

      {/* Dinyatakan di atas, bukan disembunyikan. HR yang mengira pajaknya sudah
          dihitung akan membayarkan gaji yang kurang potong. */}
      <p className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Modul ini belum menghitung PPh21 dan BPJS.</strong> Yang dihitung
        hanya komponen yang Anda konfigurasi sendiri. Perhitungan pajak dan iuran
        menunggu verifikasi ahli payroll beserta uji terhadap slip nyata — sampai
        itu selesai, hasil di sini belum dapat dipakai sebagai dasar pembayaran.
      </p>

      {/*
        Hasil unduhan dilaporkan, termasuk ketika berkasnya TERPOTONG. Berkas
        yang terpotong diam-diam terlihat persis seperti berkas yang lengkap.
      */}
      {unduhan && (
        <p
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            unduhan.ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
          }`}
        >
          {unduhan.ok
            ? unduhan.truncated
              ? `${unduhan.fileName} terunduh, tetapi TERPOTONG pada ${unduhan.rows} baris.`
              : `${unduhan.fileName} terunduh${unduhan.rows ? ` — ${unduhan.rows} baris` : ''}.`
            : unduhan.error}
        </p>
      )}

      <section className="mb-5 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500 dark:text-slate-400">Bulan</span>
          <select
            value={form.month}
            onChange={(e) => setForm((f) => ({ ...f, month: Number(e.target.value) }))}
            className={FIELD}
          >
            {BULAN.map((label, index) => (
              <option key={label} value={index + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500 dark:text-slate-400">Tahun</span>
          <input
            type="number"
            value={form.year}
            min={2000}
            max={2100}
            onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))}
            className={`${FIELD} w-24`}
          />
        </label>
        <button
          onClick={() => void createRun()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          Buat run
        </button>
      </section>

      {message && (
        <p
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="space-y-2">
        {runs.map((run) => (
          <article
            key={run.id}
            className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {BULAN[run.periodMonth - 1]} {run.periodYear}
                  <span className="ml-1.5 font-mono text-xs text-slate-400">{run.runNumber}</span>
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {run.employeeCount} karyawan · bruto {rupiah(run.totalGross)} · neto{' '}
                  {rupiah(run.totalNet)}
                </p>
                {run.lastError && (
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{run.lastError}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    STATUS_TONE[run.status] ?? STATUS_TONE['DRAFT']!
                  }`}
                >
                  {run.status}
                </span>

                {/*
                  Hanya DRAFT dan FAILED.

                  Sebelumnya CALCULATED ikut menampilkan tombol ini, dan
                  menekannya selalu menghasilkan 409 — server memang tidak pernah
                  menerima perhitungan ulang atas run yang sudah selesai.
                  Tombol yang selalu gagal adalah tombol yang mengajarkan orang
                  untuk mengabaikan pesan galat.

                  FAILED tetap ada, dan kini berarti sesuatu: run yang terputus
                  melanjutkan dari potongan terakhir yang ter-commit.
                */}
                {['DRAFT', 'FAILED'].includes(run.status) && (
                  <button
                    onClick={() =>
                      void act(
                        run.id,
                        { action: 'calculate' },
                        'Perhitungan berjalan di latar belakang.',
                      )
                    }
                    disabled={busy}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    {run.status === 'FAILED' ? 'Lanjutkan' : 'Hitung'}
                  </button>
                )}

                {run.status === 'CALCULATING' && (
                  <span className="text-sm text-slate-500">
                    Menghitung… {run.employeeCount > 0 && `${run.employeeCount} slip selesai`}
                  </span>
                )}

                {run.status === 'CALCULATED' && canApprove && (
                  <button
                    onClick={() => void act(run.id, { action: 'approve' }, 'Run disetujui. Slip kini terlihat karyawan.')}
                    disabled={busy}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Setujui
                  </button>
                )}

                {/*
                  Persetujuan dan pembayaran adalah dua peristiwa berbeda yang
                  sering terpisah berhari-hari: run disetujui tanggal 25,
                  transfer bank dieksekusi tanggal 28. Tanpa pembedaan itu,
                  pertanyaan "apakah gaji bulan lalu sudah benar-benar keluar"
                  tidak punya jawaban di dalam sistem — dan yang bertanya adalah
                  karyawan yang uangnya belum masuk.
                */}
                {/* Bahan unggahan transfer massal bank. Tersedia sejak run
                    dihitung — bagian keuangan sering memeriksa angkanya sebelum
                    persetujuan, dan menahannya sampai APPROVED berarti mereka
                    menyalinnya dari layar dengan tangan. */}
                {['CALCULATED', 'APPROVED', 'PAID'].includes(run.status) && (
                  <button
                    onClick={() =>
                      void unduh(
                        `/api/payroll/runs/export?runId=${run.id}`,
                        `gaji-${run.runNumber.replace(/\//g, '-')}.xlsx`,
                      )
                    }
                    disabled={unduhBusy}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    {unduhBusy ? 'Menyiapkan…' : 'Ekspor .xlsx'}
                  </button>
                )}

                {run.status === 'APPROVED' && canApprove && (
                  <button
                    onClick={() =>
                      void act(run.id, { action: 'markPaid' }, 'Ditandai sudah dibayarkan.')
                    }
                    disabled={busy}
                    className="rounded-md border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                  >
                    Tandai sudah dibayar
                  </button>
                )}

                <button
                  onClick={() => void (detail?.run.id === run.id ? setDetail(null) : openRun(run.id))}
                  className="rounded-md px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  {detail?.run.id === run.id ? 'Tutup' : 'Rincian'}
                </button>
              </div>
            </div>

            {detail?.run.id === run.id && (
              <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Karyawan</th>
                      <th className="px-4 py-2 text-right font-medium">Bruto</th>
                      <th className="px-4 py-2 text-right font-medium">Potongan</th>
                      <th className="px-4 py-2 text-right font-medium">Neto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.payslips.map((slip) => (
                      <tr
                        key={slip.id}
                        className="border-t border-slate-100 dark:border-slate-800/60"
                      >
                        <td className="px-4 py-2">
                          {slip.employee?.fullName ?? '—'}{' '}
                          <span className="font-mono text-xs text-slate-400">
                            {slip.employee?.employeeNumber}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{rupiah(slip.gross)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {rupiah(slip.deduction)}
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums">
                          {rupiah(slip.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        ))}
      </div>
    </AppShell>
  );
}
