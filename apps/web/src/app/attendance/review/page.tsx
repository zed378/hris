'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Antrean tinjauan presensi bertanda (dokumen 10 §7).
 *
 * Layar ini adalah tempat prinsip P14 benar-benar hidup atau mati. Sistem sudah
 * menilai bukti dan menandai yang mencurigakan — tetapi penilaian mesin tidak
 * pernah menjadi keputusan. Yang memutuskan adalah orang yang tahu bahwa gudang
 * itu memang beratap seng dan GPS selalu meleset di sana.
 *
 * Karena itu setiap baris menampilkan **alasan** penandaan, bukan sekadar skor.
 * Angka 45/100 tidak dapat ditindaklanjuti; "1,2 km dari lokasi kerja" dapat.
 */

interface FlaggedPunch {
  id: string;
  type: string;
  source: string;
  punchedAt: string;
  workDate: string;
  site: string | null;
  distanceM: number | null;
  accuracyM: number | null;
  trustScore: number;
  flags: Array<{ code: string; message: string }>;
  hasPhoto: boolean;
  employee: { id: string; employeeNumber: string; fullName: string } | null;
}

interface Stats {
  pending: number;
  total: number;
  flaggedRatio: number;
}

export default function ReviewPage() {
  const { api } = useSession();
  const [punches, setPunches] = useState<FlaggedPunch[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api('/api/attendance/review');
    if (response.ok) {
      const json = (await response.json()) as { punches: FlaggedPunch[]; stats: Stats };
      setPunches(json.punches);
      setStats(json.stats);
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (punchId: string, approve: boolean) => {
      const reason = (note[punchId] ?? '').trim();
      if (reason.length < 4) return;

      setBusy(punchId);
      const response = await api('/api/attendance/review', {
        method: 'POST',
        body: JSON.stringify({ punchId, approve, reason }),
      });
      if (response.ok) {
        setPunches((rows) => rows.filter((row) => row.id !== punchId));
        setStats((s) => (s ? { ...s, pending: s.pending - 1 } : s));
      }
      setBusy(null);
    },
    [api, note],
  );

  // Ambang 12% dari PLAN/12 §11. Di atas itu, HR berhenti meninjau dan skor
  // kepercayaan berubah menjadi teater — jadi angkanya ditampilkan, bukan
  // disembunyikan di dashboard yang tidak pernah dibuka.
  const ratioTooHigh = (stats?.flaggedRatio ?? 0) > 0.12;

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Tinjauan Presensi</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Presensi di bawah ini ditandai sistem, bukan ditolak. Semuanya tetap
          tercatat — yang diputuskan di sini adalah apakah ia dihitung.
        </p>
      </header>

      {stats && (
        <div
          className={`mb-5 rounded-lg border p-4 text-sm ${
            ratioTooHigh
              ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
              : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
          }`}
        >
          <p>
            <span className="font-medium">{stats.pending}</span> menunggu tinjauan dari{' '}
            {stats.total.toLocaleString('id-ID')} presensi (
            {(stats.flaggedRatio * 100).toFixed(1)}%)
          </p>
          {ratioTooHigh && (
            <p className="mt-2 text-amber-800 dark:text-amber-200">
              Lebih dari 12% presensi masuk antrean. Ambang kepercayaan kemungkinan
              terlalu ketat — periksa radius geofence dan batas akurasi GPS lokasi
              kerja Anda. Antrean yang terlalu panjang akan berhenti ditinjau.
            </p>
          )}
        </div>
      )}

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {!loading && punches.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Tidak ada presensi yang perlu ditinjau.
        </p>
      )}

      <div className="space-y-3">
        {punches.map((punch) => (
          <article
            key={punch.id}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">
                  {punch.employee?.fullName ?? 'Karyawan tidak dikenal'}{' '}
                  <span className="font-mono text-xs text-slate-400">
                    {punch.employee?.employeeNumber}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {punch.type === 'IN' ? 'Masuk' : 'Pulang'} ·{' '}
                  {new Date(punch.punchedAt).toLocaleString('id-ID')} · {punch.source}
                  {punch.site && ` · ${punch.site}`}
                </p>
              </div>

              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  punch.trustScore < 40
                    ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                }`}
              >
                skor {punch.trustScore}
              </span>
            </div>

            {/* Alasan, bukan skor. Angka tidak dapat ditindaklanjuti; kalimat
                "1,2 km dari lokasi kerja" dapat. */}
            <ul className="mt-3 space-y-1 text-sm text-amber-700 dark:text-amber-300">
              {punch.flags.map((flag) => (
                <li key={flag.code}>• {flag.message}</li>
              ))}
            </ul>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={note[punch.id] ?? ''}
                onChange={(e) => setNote((n) => ({ ...n, [punch.id]: e.target.value }))}
                placeholder="Alasan keputusan (wajib)"
                className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950"
              />
              <button
                onClick={() => void decide(punch.id, true)}
                disabled={busy === punch.id || (note[punch.id] ?? '').trim().length < 4}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                Terima
              </button>
              <button
                onClick={() => void decide(punch.id, false)}
                disabled={busy === punch.id || (note[punch.id] ?? '').trim().length < 4}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Tolak
              </button>
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
