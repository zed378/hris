'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Struktur gaji per karyawan (PLAN/12 F5, prinsip P13).
 *
 * Riwayat ditampilkan penuh, bukan hanya nilai yang berlaku sekarang.
 * "Sejak kapan gaji saya segini" adalah pertanyaan yang selalu muncul, dan
 * jawabannya ada di baris-baris yang sudah ditutup.
 *
 * Menetapkan nilai baru MENUTUP baris lama, tidak menimpanya. Kenaikan gaji
 * bulan Juli tidak boleh mengubah slip bulan Juni — dan slip Juni harus tetap
 * dapat dihitung ulang dengan angka yang berlaku saat itu, misalnya ketika ada
 * koreksi presensi yang datang belakangan.
 */

interface EmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
}

interface Component {
  id: string;
  code: string;
  name: string;
  calcMethod: string;
}

interface Structure {
  id: string;
  componentCode: string;
  componentName: string;
  type: string;
  amount: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
  note: string | null;
}

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

const rupiah = (value: number | null): string =>
  value === null ? '—' : new Intl.NumberFormat('id-ID').format(value);

export default function SalaryStructuresPage() {
  const { api, can } = useSession();
  const canManage = can('payroll.salary.manage');

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [structures, setStructures] = useState<Structure[]>([]);

  const [form, setForm] = useState({
    componentCode: '',
    amount: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    note: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [empRes, compRes] = await Promise.all([
        api('/api/employees?limit=500'),
        api('/api/payroll/components'),
      ]);
      if (empRes.ok) {
        setEmployees(((await empRes.json()) as { employees?: EmployeeOption[] }).employees ?? []);
      }
      if (compRes.ok) {
        const json = (await compRes.json()) as { components: Component[] };
        // Komponen berformula dihitung, bukan ditetapkan per karyawan.
        // Menampilkannya di sini akan mengundang orang mengisi nilai yang lalu
        // diabaikan mesin perhitungan.
        const assignable = json.components.filter((c) => c.calcMethod !== 'FORMULA');
        setComponents(assignable);
        setForm((f) => (f.componentCode ? f : { ...f, componentCode: assignable[0]?.code ?? '' }));
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    if (!employeeId) {
      setStructures([]);
      return;
    }
    const response = await api(`/api/payroll/salary?employeeId=${employeeId}`);
    if (response.ok) {
      setStructures(((await response.json()) as { structures: Structure[] }).structures);
    }
  }, [api, employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const response = await api('/api/payroll/salary', {
      method: 'POST',
      body: JSON.stringify({
        employeeId,
        componentCode: form.componentCode,
        amount: Number(form.amount),
        effectiveFrom: form.effectiveFrom,
        note: form.note.trim() || undefined,
      }),
    });

    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    setMessage(
      response.ok
        ? {
            tone: 'ok',
            text: 'Nilai baru berlaku. Nilai sebelumnya ditutup, bukan dihapus — slip lama tetap utuh.',
          }
        : { tone: 'error', text: json?.error?.message ?? 'Penetapan gagal.' },
    );

    if (response.ok) {
      setForm((f) => ({ ...f, amount: '', note: '' }));
      void load();
    }
    setBusy(false);
  }, [api, employeeId, form, load]);

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Struktur Gaji</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Menetapkan nilai baru menutup nilai sebelumnya. Riwayatnya tetap ada,
          sehingga slip bulan lalu dapat dihitung ulang dengan angka yang berlaku
          saat itu.
        </p>
      </header>

      <select
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
        className={`${FIELD} mb-4 min-w-64`}
      >
        <option value="">Pilih karyawan…</option>
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.employeeNumber} — {employee.fullName}
          </option>
        ))}
      </select>

      {employeeId && canManage && (
        <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-medium">Tetapkan nilai</h2>

          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={form.componentCode}
              onChange={(e) => setForm((f) => ({ ...f, componentCode: e.target.value }))}
              className={FIELD}
            >
              {components.map((component) => (
                <option key={component.id} value={component.code}>
                  {component.name}
                </option>
              ))}
            </select>

            <input
              type="number"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              placeholder="Nilai (rupiah)"
              className={`${FIELD} w-40`}
            />

            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
              className={FIELD}
            />

            <input
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="Catatan, mis. penyesuaian tahunan"
              className={`${FIELD} min-w-0 flex-1`}
            />

            <button
              onClick={() => void save()}
              disabled={busy || form.amount === ''}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Menyimpan…' : 'Tetapkan'}
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
      )}

      {!employeeId && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Pilih karyawan untuk melihat struktur gajinya.
        </p>
      )}

      {employeeId && structures.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada nilai yang ditetapkan. Tanpa gaji pokok, slip karyawan ini
          akan bernilai nol.
        </p>
      )}

      {structures.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Komponen</th>
                <th className="px-3 py-2 text-right font-medium">Nilai</th>
                <th className="px-3 py-2 font-medium">Berlaku</th>
                <th className="px-3 py-2 font-medium">Catatan</th>
              </tr>
            </thead>
            <tbody>
              {structures.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-slate-100 last:border-0 dark:border-slate-800/60 ${
                    row.current ? '' : 'text-slate-400'
                  }`}
                >
                  <td className="px-3 py-2">
                    {row.componentName}
                    {row.current && (
                      <span className="ml-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        berlaku
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{rupiah(row.amount)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.effectiveFrom} – {row.effectiveTo ?? 'sekarang'}
                  </td>
                  <td className="px-3 py-2">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
