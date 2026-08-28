'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Slip gaji saya (PLAN/12 F5).
 *
 * Yang membedakan layar ini dari daftar angka: **setiap baris membawa
 * penjelasannya.** Saat karyawan bertanya mengapa potongannya sekian, jawaban
 * yang dapat dipakai adalah rinciannya — bukan "begitu hasil sistemnya".
 *
 * Slip dari run yang belum disetujui tidak ditampilkan angkanya. Angka yang
 * berubah setelah orang melihatnya menimbulkan pertanyaan yang jauh lebih mahal
 * daripada menunggu satu hari sampai run disetujui.
 */

interface PayslipSummary {
  id: string;
  runNumber: string;
  periodYear: number;
  periodMonth: number;
  released: boolean;
  gross: number;
  deduction: number;
  net: number;
}

interface PayslipLine {
  code: string;
  name: string;
  type: string;
  amount: number;
  explanation: string | null;
  expression: string | null;
  inputs: Record<string, string> | null;
}

interface PayslipDetail extends PayslipSummary {
  snapshot: Record<string, number>;
  lines: PayslipLine[];
}

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const rupiah = (value: number): string =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
    .format(value);

const LABEL_POTRET: Record<string, string> = {
  hariKerja: 'Hari kerja',
  hariHadir: 'Hari hadir',
  hariAlfa: 'Hari tidak hadir',
  hariCutiTanpaGaji: 'Cuti tanpa gaji',
  menitTerlambat: 'Menit terlambat',
  menitLembur: 'Menit lembur',
  masaKerjaBulan: 'Masa kerja (bulan)',
  hariKalender: 'Hari kalender',
};

export default function MyPayslipsPage() {
  const { api } = useSession();
  const [payslips, setPayslips] = useState<PayslipSummary[]>([]);
  const [detail, setDetail] = useState<PayslipDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/payroll/payslips');
      if (response.ok) {
        setPayslips(((await response.json()) as { payslips: PayslipSummary[] }).payslips);
      }
      setLoading(false);
    })();
  }, [api]);

  const open = useCallback(
    async (id: string) => {
      if (detail?.id === id) {
        setDetail(null);
        return;
      }
      const response = await api(`/api/payroll/payslips?id=${id}`);
      if (response.ok) {
        setDetail(((await response.json()) as { payslip: PayslipDetail }).payslip);
      }
    },
    [api, detail],
  );

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Slip Gaji Saya</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Setiap angka disertai penjelasan cara menghitungnya.
        </p>
      </header>

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {!loading && payslips.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada slip gaji.
        </p>
      )}

      <div className="space-y-2">
        {payslips.map((slip) => (
          <article
            key={slip.id}
            className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <button
              onClick={() => void open(slip.id)}
              disabled={!slip.released}
              className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left disabled:cursor-not-allowed"
            >
              <div>
                <p className="font-medium">
                  {BULAN[slip.periodMonth - 1]} {slip.periodYear}
                  <span className="ml-1.5 font-mono text-xs text-slate-400">{slip.runNumber}</span>
                </p>
                {!slip.released && (
                  <p className="mt-0.5 text-sm text-amber-700 dark:text-amber-300">
                    Belum disetujui — angkanya masih dapat berubah.
                  </p>
                )}
              </div>

              {slip.released ? (
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">{rupiah(slip.net)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    bruto {rupiah(slip.gross)} · potongan {rupiah(slip.deduction)}
                  </p>
                </div>
              ) : (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  Menunggu persetujuan
                </span>
              )}
            </button>

            {detail?.id === slip.id && (
              <div className="border-t border-slate-200 p-4 dark:border-slate-800">
                <table className="w-full text-sm">
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr
                        key={line.code}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                      >
                        <td className="py-2 pr-3 align-top">
                          <p className="font-medium">{line.name}</p>
                          {/* Penjelasan per baris. Inilah yang membedakan slip
                              yang dapat dipertanggungjawabkan dari slip yang
                              hanya berisi angka. */}
                          {line.explanation && (
                            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                              {line.explanation}
                            </p>
                          )}
                        </td>
                        <td
                          className={`py-2 text-right align-top tabular-nums ${
                            line.type === 'DEDUCTION' ? 'text-red-600 dark:text-red-400' : ''
                          }`}
                        >
                          {line.type === 'DEDUCTION' ? '−' : ''}
                          {rupiah(line.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-slate-300 dark:border-slate-700">
                      <td className="py-2 font-medium">Gaji bersih</td>
                      <td className="py-2 text-right text-lg font-semibold tabular-nums">
                        {rupiah(detail.net)}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
                  <p className="font-medium text-slate-600 dark:text-slate-300">
                    Data yang dipakai perhitungan
                  </p>
                  <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                    {Object.entries(detail.snapshot).map(([key, value]) => (
                      <div key={key} className="flex justify-between">
                        <dt className="text-slate-500 dark:text-slate-400">
                          {LABEL_POTRET[key] ?? key}
                        </dt>
                        <dd className="tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </AppShell>
  );
}
