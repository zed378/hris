'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Jejak audit (P5).
 *
 * Jejaknya ditulis sejak Fase 1 pada setiap jalur yang mengubah data, tabelnya
 * append-only, dan hak UPDATE/DELETE-nya dicabut bahkan bagi pemilik tabel.
 * Yang tidak ada sampai sekarang: satu pun cara membacanya. Izin
 * `iam.audit.read` ada, menu ini tampil di sidebar, dan tidak ada apa pun di
 * belakangnya.
 *
 * Jejak audit yang tidak dapat dibaca bukan setengah fitur — ia nol fitur.
 * Seluruh gunanya adalah menjawab "siapa mengubah ini, kapan, dan dari nilai
 * berapa", dan yang bertanya tidak punya akses `psql`.
 */

interface Entry {
  id: string;
  at: string;
  actor: { id: string | null; fullName: string; email: string };
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  correlationId: string | null;
}

const FIELD =
  'rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

export default function AuditPage() {
  const { api } = useSession();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ action: '', entityType: '', from: '', to: '' });
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useCallback(
    (next?: string | null): string => {
      const params = new URLSearchParams();
      if (filter.action) params.set('action', filter.action);
      if (filter.entityType) params.set('entityType', filter.entityType);
      if (filter.from) params.set('from', filter.from);
      if (filter.to) params.set('to', filter.to);
      if (next) params.set('cursor', next);
      return params.toString();
    },
    [filter],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api(`/api/audit?${query()}`);
    if (response.ok) {
      const json = (await response.json()) as { entries: Entry[]; nextCursor: string | null };
      setEntries(json.entries);
      setCursor(json.nextCursor);
    }
    setLoading(false);
  }, [api, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const muatLagi = useCallback(async () => {
    if (!cursor) return;
    const response = await api(`/api/audit?${query(cursor)}`);
    if (response.ok) {
      const json = (await response.json()) as { entries: Entry[]; nextCursor: string | null };
      setEntries((prev) => [...prev, ...json.entries]);
      setCursor(json.nextCursor);
    }
  }, [api, cursor, query]);

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Jejak Audit</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Setiap perubahan data meninggalkan baris di sini, beserta pelakunya dan
        nilai sebelum–sesudahnya. Barisnya tidak dapat diubah maupun dihapus oleh
        siapa pun, termasuk oleh pemilik basis data.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <input
          value={filter.action}
          onChange={(e) => setFilter((f) => ({ ...f, action: e.target.value }))}
          placeholder="Aksi — mis. payroll."
          className={FIELD}
        />
        <input
          value={filter.entityType}
          onChange={(e) => setFilter((f) => ({ ...f, entityType: e.target.value }))}
          placeholder="Jenis entitas"
          className={FIELD}
        />
        <input
          type="date"
          value={filter.from}
          onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))}
          className={FIELD}
        />
        <input
          type="date"
          value={filter.to}
          onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))}
          className={FIELD}
        />
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Memuat…</p>
      ) : entries.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">Tidak ada jejak yang cocok.</p>
      ) : (
        <div className="mt-6 space-y-1">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm dark:border-slate-800"
            >
              <button
                onClick={() => setExpanded((id) => (id === entry.id ? null : entry.id))}
                className="flex w-full flex-wrap items-center gap-3 text-left"
              >
                <span className="font-mono text-xs text-slate-500">
                  {entry.at.slice(0, 19).replace('T', ' ')}
                </span>
                <span className="font-medium">{entry.action}</span>
                <span className="text-slate-500">{entry.actor.fullName}</span>
                <span className="ml-auto font-mono text-xs text-slate-400">
                  {entry.entityType}
                  {entry.entityId ? `/${entry.entityId.slice(0, 8)}` : ''}
                </span>
              </button>

              {expanded === entry.id && (
                <div className="mt-2 space-y-2 border-t border-slate-200 pt-2 text-xs dark:border-slate-800">
                  {/*
                    `before` dan `after` sudah diredaksi SAAT DITULIS — kunci
                    sensitif diganti `[redacted]` oleh writeAudit. Meredaksinya
                    di sini akan meninggalkan nilai aslinya tersimpan, dan
                    tersimpan adalah yang penting.
                  */}
                  {entry.before != null && (
                    <div>
                      <p className="text-slate-400">Sebelum</p>
                      <pre className="overflow-x-auto rounded bg-slate-100 p-2 dark:bg-slate-900">
                        {JSON.stringify(entry.before, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.after != null && (
                    <div>
                      <p className="text-slate-400">Sesudah</p>
                      <pre className="overflow-x-auto rounded bg-slate-100 p-2 dark:bg-slate-900">
                        {JSON.stringify(entry.after, null, 2)}
                      </pre>
                    </div>
                  )}
                  <p className="text-slate-400">
                    {entry.actor.email && `${entry.actor.email} · `}
                    {entry.ip ?? 'tanpa IP'}
                    {/*
                      Id korelasi ditampilkan supaya satu baris audit dapat
                      disambungkan ke log permintaan yang menghasilkannya —
                      termasuk log worker di seberang antrean.
                    */}
                    {entry.correlationId && ` · korelasi ${entry.correlationId}`}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <button
          onClick={() => void muatLagi()}
          className="mt-4 rounded-md border border-slate-300 px-4 py-2 text-sm transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Muat lebih banyak
        </button>
      )}
    </AppShell>
  );
}
