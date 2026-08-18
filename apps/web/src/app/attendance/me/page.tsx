'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Presensi milik sendiri (dokumen 10 §8.2).
 *
 * Karyawan melihat seluruh bukti presensinya — termasuk jarak, akurasi, dan skor
 * kepercayaannya. Ini bukan transparansi demi transparansi: sistem yang menilai
 * orang tanpa menunjukkan dasar penilaiannya adalah sistem yang tidak dapat
 * dibantah, dan penilaian yang tidak dapat dibantah akan salah tanpa ada yang
 * dapat memperbaikinya.
 */

interface Punch {
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
  review: string;
  hasPhoto: boolean;
}

interface Day {
  workDate: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
}

const STATUS_LABEL: Record<string, string> = {
  PRESENT: 'Hadir',
  LATE: 'Terlambat',
  ABSENT: 'Tidak hadir',
  LEAVE: 'Cuti',
  HOLIDAY: 'Libur',
  DAY_OFF: 'Libur mingguan',
};

const PUNCH_LABEL: Record<string, string> = {
  IN: 'Masuk',
  OUT: 'Pulang',
  BREAK_START: 'Mulai istirahat',
  BREAK_END: 'Selesai istirahat',
};

export default function MyAttendancePage() {
  const { api } = useSession();
  const [punches, setPunches] = useState<Punch[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/attendance/me?days=30');
      if (response.ok) {
        const json = (await response.json()) as { punches: Punch[]; days: Day[] };
        setPunches(json.punches);
        setDays(json.days);
      }
      setLoading(false);
    })();
  }, [api]);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Presensi Saya</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">30 hari terakhir</p>

      {loading && <p className="mt-6 text-sm text-slate-400">Memuat…</p>}

      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-600 dark:text-slate-300">Rekap harian</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Masuk</th>
                <th className="px-4 py-2">Pulang</th>
                <th className="px-4 py-2">Terlambat</th>
                <th className="px-4 py-2">Lembur</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {days.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                    Belum ada rekap.
                  </td>
                </tr>
              )}
              {days.map((day) => (
                <tr key={day.workDate}>
                  <td className="px-4 py-2 font-mono text-xs">{day.workDate}</td>
                  <td className="px-4 py-2">{STATUS_LABEL[day.status] ?? day.status}</td>
                  <td className="px-4 py-2">{formatTime(day.checkIn)}</td>
                  <td className="px-4 py-2">{formatTime(day.checkOut)}</td>
                  <td className="px-4 py-2">{day.lateMinutes > 0 ? `${day.lateMinutes} m` : '—'}</td>
                  <td className="px-4 py-2">
                    {day.overtimeMinutes > 0 ? `${day.overtimeMinutes} m` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-600 dark:text-slate-300">Bukti presensi</h2>
        <p className="mt-1 text-xs text-slate-400">
          Seluruh data yang dipakai sistem untuk menilai presensi Anda. Bila ada
          yang keliru, tunjukkan halaman ini kepada HR.
        </p>

        <div className="mt-2 space-y-2">
          {punches.map((punch) => (
            <div
              key={punch.id}
              className="rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{PUNCH_LABEL[punch.type] ?? punch.type}</span>{' '}
                  <span className="text-slate-500 dark:text-slate-400">
                    {new Date(punch.punchedAt).toLocaleString('id-ID')}
                  </span>
                </span>
                <span className="text-xs text-slate-400">
                  {punch.site ?? 'lokasi tidak dikenal'}
                  {punch.distanceM !== null && ` · ${punch.distanceM} m`}
                  {punch.accuracyM !== null && ` · ±${punch.accuracyM} m`}
                  {` · skor ${punch.trustScore}`}
                </span>
              </div>

              {punch.flags.length > 0 && (
                <ul className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {punch.flags.map((flag) => (
                    <li key={flag.code}>• {flag.message}</li>
                  ))}
                </ul>
              )}

              {punch.review === 'NEEDS_REVIEW' && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Menunggu tinjauan HR. Presensi ini tetap tercatat.
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
