'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

interface EmployeeRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  joinDate: string;
  department: string | null;
  position: string | null;
  pii: { nationalId: string | null; taxId: string | null; bankAccount: string | null };
}

const PAGE_SIZE = 25;

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  PROBATION: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  RESIGNED: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  TERMINATED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

export default function EmployeesPage() {
  const { api, can } = useSession();
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canUnmask = can('employee.pii.unmask');

  const load = useCallback(
    async (nextPage: number, query: string) => {
      setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(nextPage * PAGE_SIZE),
        ...(query ? { search: query } : {}),
      });
      const response = await api(`/api/employees?${params}`);
      if (response.ok) {
        const json = (await response.json()) as { employees: EmployeeRow[]; total: number };
        setRows(json.employees);
        setTotal(json.total);
      }
      setLoading(false);
    },
    [api],
  );

  useEffect(() => {
    // Ditunda 300 ms sejak ketikan terakhir. Tanpa jeda, mengetik "Siti"
    // mengirim empat request dan yang terakhir belum tentu tiba terakhir.
    const timer = setTimeout(() => void load(page, search), 300);
    return () => clearTimeout(timer);
  }, [load, page, search]);

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <AppShell>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Karyawan</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {total.toLocaleString('id-ID')} orang terdaftar
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Penyaring yang aktif ikut terbawa: yang terunduh persis yang
              terlihat. Ekspor yang selalu mengambil semuanya membuat orang
              mengunduh 5.000 baris PII untuk membaca 12. */}
          <a
            href={`/api/employees/export${search ? `?search=${encodeURIComponent(search)}` : ''}`}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Ekspor Excel
          </a>
          <a
            href="/api/employees/template"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Unduh templat
          </a>
          <Link
            href="/employees/import"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            Impor Excel
          </Link>
        </div>
      </header>

      <input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
        placeholder="Cari nama, nomor karyawan, atau email…"
        className="mb-4 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950"
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-4 py-3">Nomor</th>
              <th className="px-4 py-3">Nama</th>
              <th className="px-4 py-3">NIK</th>
              <th className="px-4 py-3">Masuk</th>
              <th className="px-4 py-3">Departemen</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                  Memuat…
                </td>
              </tr>
            )}

            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <p className="text-slate-500 dark:text-slate-400">
                    {search ? 'Tidak ada yang cocok.' : 'Belum ada data karyawan.'}
                  </p>
                  {!search && (
                    <Link
                      href="/employees/import"
                      className="mt-3 inline-block text-sm text-brand-600 underline"
                    >
                      Impor dari Excel untuk memulai
                    </Link>
                  )}
                </td>
              </tr>
            )}

            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="px-4 py-3 font-mono text-xs">{row.employeeNumber}</td>
                <td className="px-4 py-3 font-medium">{row.fullName}</td>
                {/* Nilai tersamar datang dari server, bukan disamarkan di sini.
                    Menyamarkan di frontend berarti nilai penuhnya sudah dikirim
                    melewati jaringan dan ada di devtools siapa pun (P9). */}
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {row.pii.nationalId ?? '—'}
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.joinDate}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                  {row.department ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLE[row.status] ?? STATUS_STYLE['RESIGNED']
                    }`}
                  >
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <p className="text-slate-500 dark:text-slate-400">
          {canUnmask ? (
            'Anda dapat melihat NIK lengkap.'
          ) : (
            <>NIK ditampilkan tersamar sesuai hak akses Anda.</>
          )}
        </p>

        {total > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-slate-300 px-3 py-1 transition hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Sebelumnya
            </button>
            <span className="text-slate-500">
              {page + 1} / {lastPage + 1}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="rounded-md border border-slate-300 px-3 py-1 transition hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Berikutnya
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
