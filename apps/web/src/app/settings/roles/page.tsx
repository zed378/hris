'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Peran dan izinnya (PLAN/05 §3).
 *
 * Menu "Peran" tampil sejak seed pertama, menuju halaman yang tidak pernah ada.
 * Endpoint-nya lengkap sejak Fase 1.
 *
 * Tanpa layar ini, peran hanya dapat memakai izin yang kebetulan diberikan seed
 * — sehingga perusahaan yang manajernya juga mengurus payroll, atau yang tidak
 * ingin HR-nya membuka samaran NIK, tidak punya jalan sama sekali. Izinnya ada,
 * pemeriksaannya bekerja, dan tidak ada tempat untuk menyusunnya.
 */

interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

interface PermissionRow {
  code: string;
  moduleCode: string;
  description: string | null;
}

export default function RolesPage() {
  const { api, can } = useSession();
  const canManage = can('iam.role.manage');

  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api('/api/roles');
    if (response.ok) {
      const json = (await response.json()) as { roles: Role[]; catalog: PermissionRow[] };
      setRoles(json.roles);
      setCatalog(json.catalog);
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const perModule = useMemo(() => {
    const groups = new Map<string, PermissionRow[]>();
    for (const permission of catalog) {
      const list = groups.get(permission.moduleCode) ?? [];
      list.push(permission);
      groups.set(permission.moduleCode, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  const mulaiSunting = useCallback((role: Role) => {
    setEditing(role);
    setDraft(new Set(role.permissions));
    setMessage(null);
  }, []);

  const simpan = useCallback(async () => {
    if (!editing) return;
    setBusy(true);
    setMessage(null);

    const response = await api(`/api/roles/${editing.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: [...draft] }),
    });

    if (response.ok) {
      setMessage({
        tone: 'ok',
        text: `Izin peran "${editing.name}" disimpan. Berlaku seketika bagi ${editing.userCount} pengguna.`,
      });
      setEditing(null);
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Penyimpanan gagal.' });
    }
    setBusy(false);
  }, [api, draft, editing, load]);

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Peran</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Hak akses diberikan lewat peran, bukan per orang. Pengecualian per orang
        diatur di layar Pengguna, dan penolakan di sana selalu menang atas apa pun
        yang tertulis di sini.
      </p>

      {message && (
        <p
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200'
          }`}
        >
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Memuat…</p>
      ) : (
        <div className="mt-6 space-y-3">
          {roles.map((role) => (
            <div
              key={role.id}
              className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{role.name}</span>
                <span className="font-mono text-xs text-slate-500">{role.code}</span>
                {role.isSystem && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    bawaan
                  </span>
                )}
                <span className="text-sm text-slate-500">
                  {role.permissions.length} izin · {role.userCount} pengguna
                </span>
                {canManage && (
                  <button
                    onClick={() => mulaiSunting(role)}
                    className="ml-auto text-sm text-brand-600 underline"
                  >
                    Sunting izin
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <section className="mt-8 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-lg font-medium">Izin untuk &ldquo;{editing.name}&rdquo;</h2>

          {/*
            Peringatan ini muncul karena perubahannya berlaku seketika dan
            berlaku untuk semua orang yang memegang peran itu — bukan pada sesi
            berikutnya, dan bukan hanya bagi orang yang sedang dipikirkan
            penyuntingnya.
          */}
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
            Perubahan berlaku seketika bagi {editing.userCount} pengguna yang
            memegang peran ini.
          </p>

          <div className="mt-4 space-y-5">
            {perModule.map(([moduleCode, permissions]) => (
              <div key={moduleCode}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {moduleCode}
                </p>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {permissions.map((permission) => (
                    <label
                      key={permission.code}
                      className="flex items-start gap-2 py-0.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={draft.has(permission.code)}
                        onChange={(e) =>
                          setDraft((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(permission.code);
                            else next.delete(permission.code);
                            return next;
                          })
                        }
                        className="mt-1"
                      />
                      <span>
                        {permission.description ?? permission.code}
                        <span className="block font-mono text-xs text-slate-400">
                          {permission.code}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex gap-3">
            <button
              onClick={() => void simpan()}
              disabled={busy}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              Simpan {draft.size} izin
            </button>
            <button
              onClick={() => setEditing(null)}
              className="rounded-md px-4 py-2 text-sm text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Batal
            </button>
          </div>
        </section>
      )}
    </AppShell>
  );
}
