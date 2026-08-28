'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Kebijakan cuti — jenis, kuota, dan penyesuaian saldo (PLAN/12 F4).
 *
 * Dua hal yang perlu terlihat jelas di layar ini, karena keduanya kerap
 * disalahpahami sampai menimbulkan sengketa:
 *
 *   1. **Jenis yang tidak memotong saldo.** Cuti melahirkan dan cuti sakit
 *      adalah hak, bukan potongan dari jatah dua belas hari. Memotongnya akan
 *      membuat seorang ibu kehilangan seluruh cuti tahunannya karena melahirkan.
 *   2. **Penyesuaian saldo selalu berbuku besar.** Angka yang berubah tanpa
 *      riwayat tidak dapat dipertahankan ketika karyawan bertanya mengapa.
 */

interface LeaveType {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  accrualMethod: string;
  defaultQuotaDays: number;
  minServiceMonths: number;
  requiresAttachment: boolean;
  deductFromBalance: boolean;
  colorHex: string;
}

interface EmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
}

interface Balance {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  entitledDays: number;
  adjustmentDays: number;
  usedDays: number;
  pendingDays: number;
  availableDays: number;
}

interface LedgerRow {
  id: string;
  entryType: string;
  days: number;
  note: string | null;
  createdAt: string;
}

const ENTRY_LABEL: Record<string, string> = {
  GRANT: 'Pemberian jatah',
  ACCRUAL: 'Akrual bulanan',
  HOLD: 'Ditahan pengajuan',
  RELEASE: 'Dilepas kembali',
  CONSUME: 'Dipakai',
  EXPIRE: 'Hangus',
  ADJUST: 'Penyesuaian HR',
};

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

export default function LeavePoliciesPage() {
  const { api, can } = useSession();
  const canManageBalance = can('leave.balance.manage');

  const [types, setTypes] = useState<LeaveType[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [balances, setBalances] = useState<Balance[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [openLedger, setOpenLedger] = useState<string | null>(null);

  const [form, setForm] = useState({ leaveTypeId: '', days: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [typeRes, empRes] = await Promise.all([
        api('/api/leave/types'),
        api('/api/employees?limit=500'),
      ]);
      if (typeRes.ok) {
        const json = (await typeRes.json()) as { types: LeaveType[] };
        setTypes(json.types);
        setForm((f) => (f.leaveTypeId ? f : { ...f, leaveTypeId: json.types[0]?.id ?? '' }));
      }
      if (empRes.ok) {
        const json = (await empRes.json()) as { employees?: EmployeeOption[] };
        setEmployees(json.employees ?? []);
      }
    })();
  }, [api]);

  const loadBalances = useCallback(async () => {
    if (!employeeId) {
      setBalances([]);
      return;
    }
    const response = await api(`/api/leave/balances?employeeId=${employeeId}`);
    if (response.ok) setBalances(((await response.json()) as { balances: Balance[] }).balances);
  }, [api, employeeId]);

  useEffect(() => {
    void loadBalances();
    setOpenLedger(null);
    setLedger([]);
  }, [loadBalances]);

  const showLedger = useCallback(
    async (balanceId: string) => {
      if (openLedger === balanceId) {
        setOpenLedger(null);
        return;
      }
      const response = await api(
        `/api/leave/balances?employeeId=${employeeId}&ledgerFor=${balanceId}`,
      );
      if (response.ok) {
        const json = (await response.json()) as { ledger?: LedgerRow[] };
        setLedger(json.ledger ?? []);
        setOpenLedger(balanceId);
      }
    },
    [api, employeeId, openLedger],
  );

  const adjust = useCallback(async () => {
    const days = Number(form.days);
    if (!employeeId || !form.leaveTypeId || Number.isNaN(days) || form.reason.trim().length < 4) {
      return;
    }

    setBusy(true);
    setMessage(null);

    const response = await api('/api/leave/balances', {
      method: 'POST',
      body: JSON.stringify({
        employeeId,
        leaveTypeId: form.leaveTypeId,
        periodYear: new Date().getFullYear(),
        days,
        reason: form.reason.trim(),
      }),
    });

    if (response.ok) {
      setMessage({
        tone: 'ok',
        text: `Saldo disesuaikan ${days > 0 ? '+' : ''}${days} hari. Mutasinya tercatat di buku besar.`,
      });
      setForm((f) => ({ ...f, days: '', reason: '' }));
      void loadBalances();
    } else {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Penyesuaian gagal.' });
    }
    setBusy(false);
  }, [api, employeeId, form, loadBalances]);

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Kebijakan Cuti</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Jenis cuti yang berlaku, dan penyesuaian saldo per karyawan.
        </p>
      </header>

      <section className="mb-6 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Jenis</th>
              <th className="px-3 py-2 font-medium">Kuota</th>
              <th className="px-3 py-2 font-medium">Masa kerja min.</th>
              <th className="px-3 py-2 font-medium">Potong saldo</th>
              <th className="px-3 py-2 font-medium">Lampiran</th>
              <th className="px-3 py-2 font-medium">Berbayar</th>
            </tr>
          </thead>
          <tbody>
            {types.map((type) => (
              <tr
                key={type.id}
                className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
              >
                <td className="px-3 py-2">
                  <span
                    className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                    style={{ backgroundColor: type.colorHex }}
                  />
                  {type.name}
                  <span className="ml-1.5 font-mono text-xs text-slate-400">{type.code}</span>
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {type.accrualMethod === 'UNLIMITED'
                    ? 'tanpa batas'
                    : type.deductFromBalance
                      ? `${type.defaultQuotaDays} hari`
                      : '—'}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {type.minServiceMonths === 0 ? 'tanpa syarat' : `${type.minServiceMonths} bulan`}
                </td>
                <td className="px-3 py-2">
                  {type.deductFromBalance ? (
                    'Ya'
                  ) : (
                    <span
                      className="text-slate-500 dark:text-slate-400"
                      title="Hak yang tidak berbasis kuota tahunan — memotongnya akan menghabiskan jatah cuti tahunan karyawan."
                    >
                      Tidak
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{type.requiresAttachment ? 'Wajib' : '—'}</td>
                <td className="px-3 py-2">{type.isPaid ? 'Ya' : 'Tidak'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2 className="mb-3 text-sm font-medium">Saldo per karyawan</h2>

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

      {employeeId && canManageBalance && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-sm font-medium">Sesuaikan saldo</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Nilai positif menambah, negatif mengurangi. Setiap penyesuaian tercatat
            di buku besar beserta alasan dan nama Anda.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={form.leaveTypeId}
              onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))}
              className={FIELD}
            >
              {types
                .filter((type) => type.deductFromBalance)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>

            <input
              type="number"
              step="0.5"
              value={form.days}
              onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
              placeholder="± hari"
              className={`${FIELD} w-28`}
            />

            <input
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="Alasan penyesuaian (wajib)"
              className={`${FIELD} min-w-0 flex-1`}
            />

            <button
              onClick={() => void adjust()}
              disabled={busy || form.days === '' || form.reason.trim().length < 4}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Menyimpan…' : 'Sesuaikan'}
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

      <div className="space-y-2">
        {balances.map((balance) => (
          <article
            key={balance.id}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{balance.leaveTypeName}</p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  jatah {balance.entitledDays} · penyesuaian {balance.adjustmentDays} · terpakai{' '}
                  {balance.usedDays} · ditahan {balance.pendingDays}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold tabular-nums">
                  {balance.availableDays}
                  <span className="ml-1 text-sm font-normal text-slate-500">tersedia</span>
                </span>
                <button
                  onClick={() => void showLedger(balance.id)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {openLedger === balance.id ? 'Tutup riwayat' : 'Riwayat mutasi'}
                </button>
              </div>
            </div>

            {openLedger === balance.id && (
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {ledger.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-1.5 text-slate-400">
                        {new Date(row.createdAt).toLocaleString('id-ID')}
                      </td>
                      <td className="py-1.5">{ENTRY_LABEL[row.entryType] ?? row.entryType}</td>
                      <td className="py-1.5 tabular-nums">
                        {row.days > 0 ? '+' : ''}
                        {row.days}
                      </td>
                      <td className="py-1.5 text-slate-500 dark:text-slate-400">{row.note}</td>
                    </tr>
                  ))}
                  {ledger.length === 0 && (
                    <tr>
                      <td className="py-2 text-slate-400">Belum ada mutasi.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </article>
        ))}
      </div>
    </AppShell>
  );
}
