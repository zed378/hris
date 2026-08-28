'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Komponen gaji (PLAN/12 F5).
 *
 * Formula diperiksa SAAT DIKETIK, bukan saat run berjalan. Perbedaannya bukan
 * kenyamanan: formula yang salah ditemukan saat run berarti ditemukan pada
 * tanggal 25, ketika seribu slip harus keluar besok pagi dan orang yang
 * menulisnya sudah lupa apa maksudnya.
 *
 * Daftar variabel yang tersedia ditampilkan terus-menerus, bukan disembunyikan
 * di balik bantuan. Nama variabel yang ditebak salah adalah penyebab paling
 * umum formula ditolak.
 */

interface Component {
  id: string;
  code: string;
  name: string;
  type: string;
  calcMethod: string;
  amount: number | null;
  expression: string | null;
  rate: number | null;
  baseComponentCode: string | null;
  taxable: boolean;
  bpjsBase: boolean;
  sortOrder: number;
  isActive: boolean;
}

interface FormulaCheck {
  ok: boolean;
  variables: string[];
  error: { message: string; position?: number } | null;
}

const TYPE_LABEL: Record<string, string> = {
  EARNING: 'Pendapatan',
  DEDUCTION: 'Potongan',
  EMPLOYER_CONTRIBUTION: 'Iuran perusahaan',
  INFO: 'Informasi',
};

const METHOD_LABEL: Record<string, string> = {
  FIXED: 'Nilai tetap',
  FORMULA: 'Formula',
  PER_DAY: 'Per hari hadir',
  PER_HOUR: 'Per jam lembur',
  PERCENTAGE: 'Persentase',
};

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

export default function PayrollComponentsPage() {
  const { api } = useSession();

  const [components, setComponents] = useState<Component[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [functions, setFunctions] = useState<string[]>([]);
  const [check, setCheck] = useState<FormulaCheck | null>(null);

  const [form, setForm] = useState({
    code: '',
    name: '',
    type: 'EARNING',
    calcMethod: 'FIXED',
    amount: '',
    expression: '',
    rate: '',
    baseComponentCode: '',
    taxable: true,
    bpjsBase: false,
    sortOrder: '100',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await api('/api/payroll/components');
    if (response.ok) {
      const json = (await response.json()) as {
        components: Component[];
        variables: string[];
        functions: string[];
      };
      setComponents(json.components);
      setVariables(json.variables);
      setFunctions(json.functions);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pemeriksaan berjalan saat mengetik, dengan jeda supaya tidak satu permintaan
  // per ketukan tuts.
  useEffect(() => {
    if (form.calcMethod !== 'FORMULA' || form.expression.trim() === '') {
      setCheck(null);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        const response = await api('/api/payroll/components', {
          method: 'PUT',
          body: JSON.stringify({ expression: form.expression, code: form.code || undefined }),
        });
        if (response.ok) setCheck((await response.json()) as FormulaCheck);
      })();
    }, 400);

    return () => clearTimeout(timer);
  }, [api, form.expression, form.calcMethod, form.code]);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const response = await api('/api/payroll/components', {
      method: 'POST',
      body: JSON.stringify({
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        calcMethod: form.calcMethod,
        amount: form.amount === '' ? null : Number(form.amount),
        expression: form.expression.trim() || null,
        rate: form.rate === '' ? null : Number(form.rate),
        baseComponentCode: form.baseComponentCode.trim() || null,
        taxable: form.taxable,
        bpjsBase: form.bpjsBase,
        sortOrder: Number(form.sortOrder) || 0,
      }),
    });

    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    setMessage(
      response.ok
        ? { tone: 'ok', text: `Komponen ${form.code} tersimpan.` }
        : { tone: 'error', text: json?.error?.message ?? 'Komponen gagal disimpan.' },
    );

    if (response.ok) {
      setForm((f) => ({ ...f, code: '', name: '', expression: '', amount: '' }));
      void load();
    }
    setBusy(false);
  }, [api, form, load]);

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Komponen Gaji</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Kode komponen menjadi nama variabel di dalam formula, karena itu hanya
          boleh berisi huruf, angka, dan garis bawah.
        </p>
      </header>

      <section className="mb-5 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Urut</th>
              <th className="px-3 py-2 font-medium">Kode</th>
              <th className="px-3 py-2 font-medium">Nama</th>
              <th className="px-3 py-2 font-medium">Jenis</th>
              <th className="px-3 py-2 font-medium">Metode</th>
              <th className="px-3 py-2 font-medium">Nilai / Formula</th>
            </tr>
          </thead>
          <tbody>
            {components.map((component) => (
              <tr
                key={component.id}
                className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
              >
                <td className="px-3 py-2 tabular-nums text-slate-400">{component.sortOrder}</td>
                <td className="px-3 py-2 font-mono text-xs">{component.code}</td>
                <td className="px-3 py-2">{component.name}</td>
                <td className="px-3 py-2">{TYPE_LABEL[component.type] ?? component.type}</td>
                <td className="px-3 py-2">
                  {METHOD_LABEL[component.calcMethod] ?? component.calcMethod}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {component.expression ??
                    (component.rate !== null
                      ? `${component.rate * 100}% × ${component.baseComponentCode}`
                      : component.amount !== null
                        ? component.amount.toLocaleString('id-ID')
                        : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">Tambah atau ubah komponen</h2>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            placeholder="KODE_KOMPONEN"
            className={`${FIELD} font-mono`}
          />
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Nama komponen"
            className={FIELD}
          />
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className={FIELD}
          >
            {Object.entries(TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={form.calcMethod}
            onChange={(e) => setForm((f) => ({ ...f, calcMethod: e.target.value }))}
            className={FIELD}
          >
            {Object.entries(METHOD_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {form.calcMethod === 'FORMULA' ? (
          <>
            <input
              value={form.expression}
              onChange={(e) => setForm((f) => ({ ...f, expression: e.target.value }))}
              placeholder="mis. if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)"
              className={`mt-2 w-full ${FIELD} font-mono`}
            />

            {/* Umpan balik saat mengetik. Formula yang salah ditemukan saat run
                berarti ditemukan pada tanggal 25. */}
            {check && (
              <p
                className={`mt-2 rounded-md px-3 py-2 text-sm ${
                  check.ok
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
                }`}
              >
                {check.ok
                  ? `Formula sah. Memakai: ${check.variables.join(', ') || '(tanpa variabel)'}`
                  : check.error?.message}
              </p>
            )}

            <div className="mt-2 rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
              <p className="font-medium text-slate-600 dark:text-slate-300">Variabel tersedia</p>
              <p className="mt-1 font-mono text-slate-500 dark:text-slate-400">
                {variables.join(' · ')}
              </p>
              <p className="mt-2 font-medium text-slate-600 dark:text-slate-300">Fungsi</p>
              <p className="mt-1 font-mono text-slate-500 dark:text-slate-400">
                {functions.join(' · ')}
              </p>
            </div>
          </>
        ) : form.calcMethod === 'PERCENTAGE' ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              type="number"
              step="0.0001"
              value={form.rate}
              onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
              placeholder="Tarif, mis. 0.01 untuk 1%"
              className={FIELD}
            />
            <select
              value={form.baseComponentCode}
              onChange={(e) => setForm((f) => ({ ...f, baseComponentCode: e.target.value }))}
              className={FIELD}
            >
              <option value="">Dasar perhitungan…</option>
              {components.map((component) => (
                <option key={component.id} value={component.code}>
                  {component.code}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input
            type="number"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            placeholder="Nilai bawaan (dapat ditimpa per karyawan)"
            className={`mt-2 w-full ${FIELD}`}
          />
        )}

        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.taxable}
              onChange={(e) => setForm((f) => ({ ...f, taxable: e.target.checked }))}
            />
            Termasuk objek pajak
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.bpjsBase}
              onChange={(e) => setForm((f) => ({ ...f, bpjsBase: e.target.checked }))}
            />
            Termasuk dasar BPJS
          </label>
          <label className="flex items-center gap-2">
            Urutan
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
              className={`${FIELD} w-20`}
            />
          </label>

          <button
            onClick={() => void save()}
            disabled={busy || form.code.length < 1 || form.name.length < 2}
            className="ml-auto rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Menyimpan…' : 'Simpan komponen'}
          </button>
        </div>

        {message && (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      <p className="mt-3 text-xs text-slate-400">
        Kolom pajak dan BPJS di atas menandai komponen untuk perhitungan yang
        BELUM dibangun. Menandainya sekarang tidak menghitung apa pun; ia
        menyiapkan data supaya perhitungan kelak tidak perlu menebak.
      </p>
    </AppShell>
  );
}
