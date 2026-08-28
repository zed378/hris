'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Kalender cuti tim (PLAN/12 F4).
 *
 * Gunanya satu: mencegah tiga orang dari satu tim cuti pada minggu yang sama.
 * Manajer yang menyetujui satu per satu tanpa melihat kalender tidak punya cara
 * mengetahuinya sampai minggu itu tiba dan tidak ada yang masuk.
 *
 * Yang TIDAK ditampilkan: alasan cuti. Ia terlihat di kotak masuk persetujuan
 * oleh orang yang memang memutuskannya, tetapi kalender ini dilihat lebih
 * banyak orang — dan "cuti sakit dua minggu" cukup untuk menduga hal-hal
 * tentang kesehatan seseorang yang bukan urusan rekan setimnya.
 */

interface Request {
  id: string;
  employeeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  status: string;
}

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

/** Daftar tanggal dalam satu bulan, sebagai ISO. */
function daysOfMonth(year: number, month: number): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

export default function LeaveCalendarPage() {
  const { api } = useSession();

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());
  const [requests, setRequests] = useState<Request[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const days = useMemo(() => daysOfMonth(year, month), [year, month]);

  const load = useCallback(async () => {
    setLoading(true);

    const from = days[0];
    const to = days[days.length - 1];
    const response = await api(`/api/leave/requests?scope=all&from=${from}&to=${to}`);

    if (response.ok) {
      const json = (await response.json()) as { requests: Request[] };
      // Hanya yang sudah disetujui. Pengajuan yang masih menunggu belum tentu
      // terjadi, dan menampilkannya sebagai "tim sedang kosong" akan membuat
      // manajer menolak cuti yang sebenarnya tidak bentrok.
      setRequests(
        json.requests.filter((r) => r.status === 'APPROVED' || r.status === 'TAKEN'),
      );
    }

    const employeeRes = await api('/api/employees?limit=500');
    if (employeeRes.ok) {
      const json = (await employeeRes.json()) as {
        employees?: Array<{ id: string; fullName: string; employeeNumber: string }>;
      };
      setNames(new Map((json.employees ?? []).map((e) => [e.id, e.fullName])));
    }

    setLoading(false);
  }, [api, days]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Karyawan yang punya cuti di bulan ini, beserta tanggal-tanggalnya. */
  const rows = useMemo(() => {
    const byEmployee = new Map<string, { dates: Set<string>; types: Set<string> }>();

    for (const request of requests) {
      const entry = byEmployee.get(request.employeeId) ?? {
        dates: new Set<string>(),
        types: new Set<string>(),
      };
      entry.types.add(request.leaveTypeName);

      const cursor = new Date(`${request.startDate}T00:00:00.000Z`);
      const last = new Date(`${request.endDate}T00:00:00.000Z`);
      while (cursor.getTime() <= last.getTime()) {
        entry.dates.add(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      byEmployee.set(request.employeeId, entry);
    }

    return [...byEmployee.entries()]
      .map(([employeeId, entry]) => ({
        employeeId,
        name: names.get(employeeId) ?? 'Karyawan tidak dikenal',
        dates: entry.dates,
        types: [...entry.types].join(', '),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }, [requests, names]);

  /** Berapa orang cuti pada tiap tanggal. Dipakai menyorot hari padat. */
  const perDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const date of row.dates) counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const puncak = Math.max(0, ...perDay.values());

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Kalender Cuti</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Hanya cuti yang sudah disetujui. Alasan cuti tidak ditampilkan di sini.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className={FIELD}
        >
          {[
            'Januari',
            'Februari',
            'Maret',
            'April',
            'Mei',
            'Juni',
            'Juli',
            'Agustus',
            'September',
            'Oktober',
            'November',
            'Desember',
          ].map((label, index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>

        <input
          type="number"
          value={year}
          min={2000}
          max={2100}
          onChange={(e) => setYear(Number(e.target.value))}
          className={`${FIELD} w-24`}
        />

        {puncak > 0 && (
          <span className="ml-auto text-sm text-slate-500 dark:text-slate-400">
            Puncak {puncak} orang cuti bersamaan
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {!loading && rows.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Tidak ada cuti yang disetujui pada bulan ini.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  Karyawan
                </th>
                {days.map((iso) => (
                  <th
                    key={iso}
                    className={`w-7 px-0 py-2 text-center text-xs font-medium ${
                      isWeekend(iso)
                        ? 'text-slate-300 dark:text-slate-600'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {Number(iso.slice(8))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.employeeId}
                  className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                >
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-1.5 dark:bg-slate-900">
                    {row.name}
                    <span className="ml-1.5 text-xs text-slate-400">{row.types}</span>
                  </td>
                  {days.map((iso) => (
                    <td key={iso} className="px-0 py-1.5 text-center">
                      {row.dates.has(iso) ? (
                        <span
                          className={`inline-block h-4 w-4 rounded ${
                            isWeekend(iso)
                              ? 'bg-slate-200 dark:bg-slate-700'
                              : 'bg-brand-500'
                          }`}
                          title={`${row.name} — ${iso}`}
                        />
                      ) : (
                        <span
                          className={
                            isWeekend(iso)
                              ? 'inline-block h-4 w-4 rounded bg-slate-50 dark:bg-slate-800/50'
                              : ''
                          }
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}

              {/* Baris jumlah: inilah yang benar-benar dibaca manajer. Satu
                  baris per orang menjawab "siapa"; baris ini menjawab "berapa
                  banyak sekaligus", dan itu pertanyaan yang menentukan apakah
                  cuti berikutnya boleh disetujui. */}
              <tr className="border-t-2 border-slate-200 dark:border-slate-700">
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  Jumlah cuti
                </td>
                {days.map((iso) => {
                  const count = perDay.get(iso) ?? 0;
                  return (
                    <td
                      key={iso}
                      className={`px-0 py-1.5 text-center text-xs tabular-nums ${
                        count >= 3
                          ? 'font-semibold text-red-600 dark:text-red-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {count || ''}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
