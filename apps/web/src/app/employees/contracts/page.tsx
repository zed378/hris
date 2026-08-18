'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Kontrak kerja yang akan berakhir (dokumen 08, A5).
 *
 * Yang sudah lewat ditampilkan dengan penanda paling keras. Kontrak PKWT yang
 * dibiarkan lewat berubah menjadi PKWTT demi hukum, dan perubahan itu tidak
 * dapat dibatalkan — jadi ia bukan lagi pengingat, melainkan masalah yang sudah
 * terjadi dan perlu ditangani hari ini.
 */

interface Contract {
  id: string;
  contractNumber: string;
  type: string;
  endDate: string;
  daysLeft: number;
  employee: { id: string; employeeNumber: string; fullName: string };
}

interface Summary {
  expired: number;
  within7: number;
  within30: number;
  within90: number;
}

export default function ContractsPage() {
  const { api } = useSession();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/contracts/expiring?withinDays=90');
      if (response.ok) {
        const json = (await response.json()) as { contracts: Contract[]; summary: Summary };
        setContracts(json.contracts);
        setSummary(json.summary);
      }
      setLoading(false);
    })();
  }, [api]);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Kontrak Kerja</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Kontrak yang berakhir dalam 90 hari ke depan, dan yang sudah lewat.
      </p>

      {summary && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Sudah lewat" value={summary.expired} tone="bad" />
          <Stat label="7 hari lagi" value={summary.within7} tone="bad" />
          <Stat label="30 hari lagi" value={summary.within30} tone="warn" />
          <Stat label="90 hari lagi" value={summary.within90} />
        </div>
      )}

      {loading && <p className="mt-6 text-sm text-slate-400">Memuat…</p>}

      {!loading && contracts.length === 0 && (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Tidak ada kontrak yang akan berakhir dalam 90 hari.
        </p>
      )}

      <div className="mt-5 space-y-2">
        {contracts.map((contract) => {
          const expired = contract.daysLeft < 0;
          const urgent = contract.daysLeft >= 0 && contract.daysLeft <= 7;

          return (
            <article
              key={contract.id}
              className={`rounded-lg border p-4 ${
                expired
                  ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40'
                  : urgent
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
                    : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{contract.employee.fullName}</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {contract.employee.employeeNumber} · {contract.type} ·{' '}
                    {contract.contractNumber}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm">{contract.endDate}</p>
                  <p
                    className={`text-xs ${
                      expired
                        ? 'font-semibold text-red-700 dark:text-red-300'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {expired
                      ? `lewat ${Math.abs(contract.daysLeft)} hari`
                      : contract.daysLeft === 0
                        ? 'berakhir hari ini'
                        : `sisa ${contract.daysLeft} hari`}
                  </p>
                </div>
              </div>

              {expired && (
                <p className="mt-3 text-sm text-red-800 dark:text-red-200">
                  PKWT yang lewat tanpa perpanjangan atau pengakhiran resmi dapat
                  dianggap berubah menjadi PKWTT demi hukum. Perubahan itu tidak
                  dapat dibatalkan.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'warn' }) {
  const color =
    value === 0
      ? 'text-slate-700 dark:text-slate-200'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : tone === 'warn'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-slate-700 dark:text-slate-200';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center dark:border-slate-800 dark:bg-slate-900">
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}
