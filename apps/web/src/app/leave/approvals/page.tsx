'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { downloadFile, type DownloadOutcome } from '@/lib/download.ts';

/**
 * Kotak masuk persetujuan cuti (PLAN/12 F4).
 *
 * Setiap baris menampilkan **saldo pengaju**, bukan hanya permintaannya. Manajer
 * yang menyetujui tanpa melihat saldo akan menyetujui cuti yang lalu ditolak
 * basis data — dan yang menerima kabar buruknya adalah karyawan yang sudah
 * terlanjur memesan tiket.
 *
 * Persetujuan ganda ditangani terus terang: bila dua orang menekan tombol yang
 * sama, yang kedua menerima pesan "sudah diputuskan", bukan galat teknis dan
 * bukan keberhasilan palsu. Konkurensinya dijaga kunci baris saldo di lapisan
 * core, bukan oleh layar ini.
 */

interface Request {
  id: string;
  requestNumber: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: string;
}

interface Balance {
  leaveTypeId: string;
  availableDays: number;
  pendingDays: number;
}

export default function ApprovalsPage() {
  const { api } = useSession();

  const [unduhan, setUnduhan] = useState<DownloadOutcome | null>(null);
  const [unduhBusy, setUnduhBusy] = useState(false);

  const unduh = useCallback(
    async (path: string, nama: string) => {
      setUnduhBusy(true);
      setUnduhan(await downloadFile(api, path, nama));
      setUnduhBusy(false);
    },
    [api],
  );
  const [requests, setRequests] = useState<Request[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [balances, setBalances] = useState<Map<string, Balance[]>>(new Map());
  const [comment, setComment] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    const response = await api('/api/leave/requests?scope=inbox');
    if (!response.ok) {
      setLoading(false);
      return;
    }
    const json = (await response.json()) as { requests: Request[] };
    setRequests(json.requests);

    const employeeRes = await api('/api/employees?limit=500');
    if (employeeRes.ok) {
      const employees = (await employeeRes.json()) as {
        employees?: Array<{ id: string; employeeNumber: string; fullName: string }>;
      };
      setNames(
        new Map(
          (employees.employees ?? []).map((e) => [e.id, `${e.fullName} (${e.employeeNumber})`]),
        ),
      );
    }

    // Saldo diambil per pengaju yang muncul di kotak masuk, bukan untuk seluruh
    // karyawan: kotak masuk seorang manajer biasanya berisi beberapa orang saja.
    const unik = [...new Set(json.requests.map((r) => r.employeeId))];
    const pasangan = await Promise.all(
      unik.map(async (id) => {
        const res = await api(`/api/leave/balances?employeeId=${id}`);
        if (!res.ok) return [id, [] as Balance[]] as const;
        const data = (await res.json()) as { balances: Balance[] };
        return [id, data.balances] as const;
      }),
    );
    setBalances(new Map(pasangan));
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (request: Request, approve: boolean) => {
      const text = (comment[request.id] ?? '').trim();
      if (text.length < 4) return;

      setBusy(request.id);
      const response = await api(`/api/leave/requests/${request.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approve, comment: text }),
      });

      if (response.ok) {
        setMessage({
          tone: 'ok',
          text: `${request.requestNumber} ${approve ? 'disetujui' : 'ditolak'}.`,
        });
        setRequests((rows) => rows.filter((row) => row.id !== request.id));
      } else {
        const json = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setMessage({ tone: 'error', text: json?.error?.message ?? 'Keputusan gagal disimpan.' });
        // Muat ulang: kegagalan hampir selalu berarti orang lain sudah
        // memutuskannya, dan barisnya tidak lagi milik kotak masuk ini.
        void load();
      }
      setBusy(null);
    },
    [api, comment, load],
  );

  return (
    <AppShell>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Persetujuan Cuti</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Pengajuan yang menunggu keputusan Anda. Saldo pengaju ditampilkan supaya
            keputusannya tidak perlu ditebak.
          </p>
        </div>

        {/* Yang diekspor seluruh pengajuan tahun berjalan, bukan hanya yang
             menunggu keputusan: berkas ini dipakai untuk rapat bulanan, dan
             pengajuan yang sudah diputus justru yang paling dibahas. */}
        <button
          onClick={() => {
            const tahun = new Date().getUTCFullYear();
            void unduh(`/api/leave/requests/export?year=${tahun}`, `cuti-${tahun}.xlsx`);
          }}
          disabled={unduhBusy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {unduhBusy ? 'Menyiapkan…' : 'Ekspor .xlsx'}
        </button>
      </header>

      {/*
        Hasil unduhan dilaporkan, termasuk ketika berkasnya TERPOTONG. Berkas
        yang terpotong diam-diam terlihat persis seperti berkas yang lengkap, dan
        yang membacanya menyimpulkan sisanya memang tidak ada.
      */}
      {unduhan && (
        <p
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            unduhan.ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
          }`}
        >
          {unduhan.ok
            ? unduhan.truncated
              ? `${unduhan.fileName} terunduh, tetapi TERPOTONG pada ${unduhan.rows} baris. Persempit penyaringnya.`
              : `${unduhan.fileName} terunduh${unduhan.rows ? ` — ${unduhan.rows} baris` : ''}.`
            : unduhan.error}
        </p>
      )}

      {message && (
        <p
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          }`}
        >
          {message.text}
        </p>
      )}

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {!loading && requests.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Tidak ada pengajuan yang menunggu keputusan Anda.
        </p>
      )}

      <div className="space-y-3">
        {requests.map((request) => {
          const saldo = balances
            .get(request.employeeId)
            ?.find((b) => b.leaveTypeId === request.leaveTypeId);
          const cukup = saldo === undefined || saldo.availableDays >= 0;

          return (
            <article
              key={request.id}
              className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {names.get(request.employeeId) ?? 'Karyawan tidak dikenal'}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {request.leaveTypeName} · {request.startDate} – {request.endDate} ·{' '}
                    {request.totalDays} hari kerja
                    <span className="ml-1 font-mono text-xs">{request.requestNumber}</span>
                  </p>
                  <p className="mt-1 text-sm">{request.reason}</p>
                </div>

                {saldo && (
                  <div className="text-right text-sm">
                    <p className="text-slate-500 dark:text-slate-400">Saldo pengaju</p>
                    <p className={`font-medium tabular-nums ${cukup ? '' : 'text-red-600'}`}>
                      {saldo.availableDays} hari tersedia
                    </p>
                    {saldo.pendingDays > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        {saldo.pendingDays} hari ditahan pengajuan lain
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={comment[request.id] ?? ''}
                  onChange={(e) =>
                    setComment((c) => ({ ...c, [request.id]: e.target.value }))
                  }
                  placeholder="Komentar keputusan (wajib)"
                  className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  onClick={() => void decide(request, true)}
                  disabled={busy === request.id || (comment[request.id] ?? '').trim().length < 4}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  Setujui
                </button>
                <button
                  onClick={() => void decide(request, false)}
                  disabled={busy === request.id || (comment[request.id] ?? '').trim().length < 4}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
                >
                  Tolak
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}
