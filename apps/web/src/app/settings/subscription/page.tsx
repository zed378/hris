'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { downloadFile } from '@/lib/download.ts';

/**
 * Langganan dan modul (PLAN/12 F6).
 *
 * Layar ini adalah DoD Fase 6 dalam bentuk yang dapat dilihat: pelanggan
 * mengaktifkan dan menonaktifkan modul sendiri, tanpa menyentuh tim.
 *
 * Kalimat yang paling penting di sini bukan tombolnya, melainkan janji yang
 * ditulis di sebelahnya: **menonaktifkan modul tidak menghapus data.** Tanpa
 * janji itu dinyatakan, hampir tidak ada yang berani menekan tombolnya — dan
 * modul yang tidak berani dinonaktifkan juga tidak berani dicoba.
 */

interface ModuleState {
  code: string;
  name: string;
  description: string | null;
  tier: string;
  isCore: boolean;
  enabled: boolean;
  inPlan: boolean;
  hasData: boolean;
  disabledAt: string | null;
}

interface Subscription {
  tenant: {
    code: string;
    name: string;
    status: string;
    planCode: string;
    planName: string;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
  };
  modules: ModuleState[];
}

export default function SubscriptionPage() {
  const { api, refresh } = useSession();
  const [data, setData] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const exportAll = useCallback(async () => {
    setBusy('export');
    setMessage(null);
    const hasil = await downloadFile(api, '/api/tenant/export', 'data-perusahaan.json');
    setMessage(
      hasil.ok
        ? {
            tone: 'ok',
            text: `${hasil.fileName} tersimpan. Berkas ini memuat seluruh data perusahaan Anda — simpan di tempat yang aman.`,
          }
        : { tone: 'error', text: hasil.error ?? 'Ekspor gagal.' },
    );
    setBusy(null);
  }, [api]);

  const load = useCallback(async () => {
    const response = await api('/api/subscription');
    if (response.ok) setData((await response.json()) as Subscription);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (module: ModuleState) => {
      setBusy(module.code);
      setMessage(null);

      const response = await api('/api/subscription', {
        method: 'POST',
        body: JSON.stringify({ moduleCode: module.code, enabled: !module.enabled }),
      });

      const json = (await response.json().catch(() => null)) as {
        dataRestored?: boolean;
        error?: { message?: string };
      } | null;

      if (response.ok) {
        setMessage({
          tone: 'ok',
          text: !module.enabled
            ? json?.dataRestored
              ? `${module.name} diaktifkan kembali. Seluruh data sebelumnya kembali terlihat.`
              : `${module.name} diaktifkan.`
            : `${module.name} dinonaktifkan. Datanya tetap tersimpan.`,
        });
        await load();
        // Menu dan izin dimuat ulang tanpa login ulang — DoD Fase 6 menuntut
        // perubahan langganan tercermin di UI dalam sepuluh detik.
        await refresh();
      } else {
        setMessage({ tone: 'error', text: json?.error?.message ?? 'Perubahan gagal.' });
      }

      setBusy(null);
    },
    [api, load, refresh],
  );

  if (!data) {
    return (
      <AppShell>
        <p className="text-sm text-slate-400">Memuat…</p>
      </AppShell>
    );
  }

  const { tenant, modules } = data;

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Langganan &amp; Modul</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {tenant.name} · paket {tenant.planName}
        </p>
      </header>

      {tenant.status === 'TRIAL' && tenant.trialDaysLeft !== null && (
        <p
          className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
            tenant.trialDaysLeft <= 3
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-slate-200 bg-white text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
          }`}
        >
          Masa uji coba tersisa <strong>{tenant.trialDaysLeft} hari</strong>.
          {tenant.trialDaysLeft <= 3 && ' Data Anda tidak dihapus saat uji coba berakhir.'}
        </p>
      )}

      {/* Janji ini ditulis di atas tombol, bukan di catatan kaki. Tanpa janji
          itu dinyatakan, hampir tidak ada yang berani menekan tombolnya. */}
      <p className="mb-5 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <strong>Menonaktifkan modul tidak menghapus data.</strong> Menunya
        disembunyikan dan API-nya ditolak, tetapi seluruh isinya tetap tersimpan
        dan kembali utuh begitu modul diaktifkan lagi.
      </p>

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
        {modules.map((module) => (
          <article
            key={module.code}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${
              module.enabled
                ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50'
            }`}
          >
            <div className="min-w-0">
              <p className="font-medium">
                {module.name}
                {module.isCore && (
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    inti sistem
                  </span>
                )}
                {!module.inPlan && !module.isCore && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    di luar paket
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {module.description}
              </p>
              {/* Ditampilkan supaya orang yang mengaktifkan kembali tahu ia akan
                  menemukan datanya, bukan memulai dari kosong. */}
              {!module.enabled && module.hasData && (
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Data modul ini masih tersimpan
                  {module.disabledAt &&
                    ` sejak dinonaktifkan ${new Date(module.disabledAt).toLocaleDateString('id-ID')}`}
                  .
                </p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  module.enabled
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {module.enabled ? 'Aktif' : 'Nonaktif'}
              </span>

              {!module.isCore && (
                <button
                  onClick={() => void toggle(module)}
                  disabled={busy === module.code || (!module.enabled && !module.inPlan)}
                  className={`rounded-md px-3 py-1.5 text-sm transition disabled:opacity-40 ${
                    module.enabled
                      ? 'border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
                      : 'bg-brand-600 font-medium text-white hover:bg-brand-700'
                  }`}
                  title={
                    !module.enabled && !module.inPlan
                      ? 'Modul ini tidak termasuk paket langganan Anda'
                      : undefined
                  }
                >
                  {busy === module.code
                    ? 'Menyimpan…'
                    : module.enabled
                      ? 'Nonaktifkan'
                      : 'Aktifkan'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Perubahan berlaku seketika: menu dimuat ulang tanpa Anda perlu keluar dan
        masuk kembali.
      </p>

      {/* Diletakkan di halaman ini dengan sengaja: orang mencari cara mengekspor
          datanya justru ketika ia sedang mempertimbangkan berhenti berlangganan.
          Menyembunyikannya di menu lain akan terbaca sebagai penguncian. */}
      <section className="mt-8 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">Ekspor seluruh data</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Mengunduh seluruh data perusahaan Anda sebagai satu berkas JSON —
          karyawan, presensi, cuti, dan penggajian. Hak portabilitas data menurut
          UU No. 27 Tahun 2022.
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Berkasnya memuat data pribadi karyawan dalam bentuk asli bila Anda
          berhak membukanya. Setiap pengunduhan tercatat di jejak audit.
        </p>
        <button
          onClick={() => void exportAll()}
          disabled={busy !== null}
          className="mt-3 rounded-md border border-slate-300 px-3 py-2 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {busy === 'export' ? 'Menyiapkan berkas…' : 'Unduh data perusahaan'}
        </button>
      </section>
    </AppShell>
  );
}
