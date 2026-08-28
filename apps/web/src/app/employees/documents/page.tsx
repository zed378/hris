'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { openFile } from '@/lib/download.ts';

/**
 * Dokumen karyawan (PLAN/12 F2).
 *
 * Yang diunggah di sini adalah pindaian KTP, kartu keluarga, ijazah, dan surat
 * kontrak. Karena itu halaman ini menyatakan dua hal yang biasanya tidak
 * dinyatakan halaman unggah berkas: bahwa setiap pembukaan dokumen dicatat, dan
 * bahwa menghapus berarti mengarsipkan — berkasnya dibuang, catatannya tidak.
 *
 * Dokumen dibuka di tab baru dan tidak pernah diunduh secara otomatis. Berkas
 * yang mendarat di folder Downloads perangkat bersama bertahan jauh lebih lama
 * daripada tab yang ditutup, dan pemiliknya tidak pernah tahu ia masih ada.
 */

interface EmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
}

interface DocumentRow {
  id: string;
  kind: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
  archivedAt: string | null;
}

const KINDS = ['KTP', 'KK', 'NPWP', 'IJAZAH', 'KONTRAK', 'SERTIFIKAT', 'LAINNYA'];

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

function ukuran(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export default function DocumentsPage() {
  const { api, can } = useSession();
  const canManage = can('employee.document.manage');
  const fileInput = useRef<HTMLInputElement>(null);

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({ kind: 'KTP', title: '', expiresAt: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/employees?limit=500');
      if (!response.ok) return;
      const json = (await response.json()) as { employees?: EmployeeOption[] };
      setEmployees(json.employees ?? []);
    })();
  }, [api]);

  const load = useCallback(async () => {
    if (!employeeId) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    const response = await api(
      `/api/employees/${employeeId}/documents${showArchived ? '?archived=true' : ''}`,
    );
    if (response.ok) {
      const json = (await response.json()) as { documents: DocumentRow[] };
      setDocuments(json.documents);
    }
    setLoading(false);
  }, [api, employeeId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(async () => {
    const file = fileInput.current?.files?.[0];
    if (!file || !employeeId || form.title.trim().length < 2) return;

    setBusy(true);
    setMessage(null);

    const body = new FormData();
    body.set('file', file);
    body.set('kind', form.kind);
    body.set('title', form.title.trim());
    if (form.expiresAt) body.set('expiresAt', form.expiresAt);

    const response = await api(`/api/employees/${employeeId}/documents`, { method: 'POST', body });

    if (response.ok) {
      setMessage({ tone: 'ok', text: 'Dokumen tersimpan.' });
      setForm((f) => ({ ...f, title: '', expiresAt: '' }));
      if (fileInput.current) fileInput.current.value = '';
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Unggahan gagal.' });
    }
    setBusy(false);
  }, [api, employeeId, form, load]);

  const archive = useCallback(
    async (id: string, title: string) => {
      if (!window.confirm(`Arsipkan "${title}"? Berkasnya akan dihapus permanen.`)) return;

      const response = await api(`/api/documents/${id}`, { method: 'DELETE' });
      setMessage(
        response.ok
          ? { tone: 'ok', text: 'Dokumen diarsipkan dan berkasnya dihapus.' }
          : { tone: 'error', text: 'Pengarsipan gagal.' },
      );
      void load();
    },
    [api, load],
  );

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Dokumen Karyawan</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Pindaian KTP, kartu keluarga, ijazah, dan surat kontrak. Setiap pembukaan
          dokumen oleh selain pemiliknya dicatat.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500 dark:text-slate-400">Karyawan</span>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className={`${FIELD} min-w-64`}
          >
            <option value="">Pilih karyawan…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNumber} — {employee.fullName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Tampilkan yang diarsipkan
        </label>
      </div>

      {employeeId && canManage && (
        <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-medium">Unggah dokumen</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            PDF, JPG, PNG, atau WebP, maksimal 10 MB. Berkas Word atau Excel harap
            disimpan sebagai PDF terlebih dahulu.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <select
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              className={FIELD}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>

            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Judul dokumen"
              className={FIELD}
            />

            <label className="text-sm">
              <input
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
                className={`${FIELD} w-full`}
                title="Tanggal kedaluwarsa (opsional)"
              />
            </label>

            <button
              onClick={() => void upload()}
              disabled={busy || form.title.trim().length < 2}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Mengunggah…' : 'Unggah'}
            </button>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm dark:file:border-slate-700"
          />
        </section>
      )}

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

      {!employeeId && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Pilih karyawan untuk melihat dokumennya.
        </p>
      )}

      {employeeId && !loading && documents.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada dokumen untuk karyawan ini.
        </p>
      )}

      <div className="space-y-2">
        {documents.map((document) => (
          <article
            key={document.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${
              document.archivedAt
                ? 'border-slate-200 bg-slate-50 opacity-70 dark:border-slate-800 dark:bg-slate-900/50'
                : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
            }`}
          >
            <div className="min-w-0">
              <p className="font-medium">
                {document.title}{' '}
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {document.kind}
                </span>
                {document.expired && !document.archivedAt && (
                  <span className="ml-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    kedaluwarsa
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">
                {document.fileName} · {ukuran(document.sizeBytes)} ·{' '}
                {new Date(document.createdAt).toLocaleDateString('id-ID')}
                {document.expiresAt &&
                  ` · berlaku sampai ${new Date(document.expiresAt).toLocaleDateString('id-ID')}`}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {document.archivedAt ? (
                <span className="text-sm text-slate-400">
                  Diarsipkan {new Date(document.archivedAt).toLocaleDateString('id-ID')}
                </span>
              ) : (
                <>
                  {/* Dibuka di tab baru, tidak diunduh. Berkas yang mendarat di
                      folder Downloads perangkat bersama bertahan jauh lebih lama
                      daripada tab yang ditutup.

                      Lewat `openFile`, bukan `window.open` langsung: URL API
                      tidak membawa header Authorization, sehingga tab barunya
                      hanya akan menampilkan JSON 401. */}
                  <button
                    onClick={() =>
                      void openFile(api, `/api/documents/${document.id}`).then((hasil) => {
                        if (!hasil.ok) setMessage({ tone: 'error', text: hasil.error! });
                      })
                    }
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Buka
                  </button>
                  {canManage && (
                    <button
                      onClick={() => void archive(document.id, document.title)}
                      className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 transition hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
                    >
                      Arsipkan
                    </button>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
