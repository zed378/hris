'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Dasbor presensi langsung (PLAN/12 §3, PLAN/04 F3: dasbor diperbarui < 2 detik).
 *
 * Dua jalur, dan yang kedua bukan basa-basi: aliran SSE untuk pembaruan seketika,
 * dan polling berkala sebagai jaring pengaman. Proxy korporat, jaringan seluler
 * yang memutus koneksi diam, dan peramban lama semuanya dapat membuat aliran
 * gagal — dan dasbor yang membeku tanpa memberi tahu lebih buruk daripada dasbor
 * yang jujur mengatakan datanya berumur satu menit.
 *
 * Karena itu status koneksi ditampilkan, bukan disembunyikan. HR yang melihat
 * "terhubung" tahu angkanya hidup; yang melihat "berkala" tahu ia harus menunggu.
 *
 * `EventSource` sengaja tidak dipakai: ia tidak dapat mengirim header
 * `Authorization`, sehingga memakainya berarti memindahkan token ke query string.
 */

interface LivePunch {
  id: string;
  employeeId: string;
  type: string;
  source: string;
  punchedAt: string;
  workDate: string;
  trustScore: number;
  review: string;
}

interface EmployeeName {
  id: string;
  employeeNumber: string;
  fullName: string;
}

type Connection = 'menyambung' | 'langsung' | 'berkala';

const JENIS: Record<string, string> = {
  IN: 'Masuk',
  OUT: 'Pulang',
  BREAK_START: 'Mulai istirahat',
  BREAK_END: 'Selesai istirahat',
};

/** Selang polling saat aliran tidak tersedia. */
const POLL_MS = 20_000;
/** Berapa ketukan terakhir yang ditahan di layar. */
const MAX_ROWS = 60;

export default function LivePage() {
  const { api } = useSession();

  const [punches, setPunches] = useState<LivePunch[]>([]);
  const [names, setNames] = useState<Map<string, EmployeeName>>(new Map());
  const [connection, setConnection] = useState<Connection>('menyambung');
  const [lastAt, setLastAt] = useState<Date | null>(null);

  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  /** Menggabungkan ketukan baru tanpa menggandakan yang sudah ada. */
  const merge = useCallback((incoming: LivePunch[]) => {
    setPunches((current) => {
      const byId = new Map(current.map((punch) => [punch.id, punch]));
      for (const punch of incoming) byId.set(punch.id, punch);
      return [...byId.values()]
        .sort((a, b) => b.punchedAt.localeCompare(a.punchedAt))
        .slice(0, MAX_ROWS);
    });
    setLastAt(new Date());
  }, []);

  /** Memuat potret awal — dan, saat aliran gagal, memuat ulang berkala. */
  const loadSnapshot = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await api(`/api/attendance/records?from=${today}&to=${today}`);
    if (!response.ok || !mounted.current) return;

    // Potret memakai endpoint rekap yang sudah ada. Ia mengembalikan hari, bukan
    // ketukan — cukup untuk mengisi layar saat dibuka, sementara aliranlah yang
    // menambahkan ketukan satu per satu setelahnya.
    const json = (await response.json()) as {
      days: Array<{ employee: EmployeeName | null }>;
    };
    setNames((current) => {
      const next = new Map(current);
      for (const day of json.days) if (day.employee) next.set(day.employee.id, day.employee);
      return next;
    });
  }, [api]);

  /** Melengkapi nama untuk karyawan yang belum dikenal di layar. */
  const resolveNames = useCallback(
    async (ids: string[]) => {
      const missing = ids.filter((id) => !names.has(id));
      if (missing.length === 0) return;

      const response = await api('/api/employees?limit=500');
      if (!response.ok || !mounted.current) return;
      const json = (await response.json()) as { employees?: EmployeeName[] };
      setNames((current) => {
        const next = new Map(current);
        for (const employee of json.employees ?? []) next.set(employee.id, employee);
        return next;
      });
    },
    [api, names],
  );

  useEffect(() => {
    mounted.current = true;
    void loadSnapshot();

    const controller = new AbortController();
    abort.current = controller;
    let poll: ReturnType<typeof setInterval> | undefined;

    const fallbackToPolling = (): void => {
      if (!mounted.current || poll) return;
      setConnection('berkala');
      poll = setInterval(() => void loadSnapshot(), POLL_MS);
    };

    void (async () => {
      const response = await api('/api/attendance/live', {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      }).catch(() => null);

      if (!response?.ok || !response.body) {
        fallbackToPolling();
        return;
      }

      setConnection('langsung');

      // Penguraian SSE ditulis tangan: formatnya adalah blok yang dipisah baris
      // kosong, dan satu-satunya kehalusan adalah blok dapat terpotong di tengah
      // antar-chunk. Buffer di bawah menahan potongan itu.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event !== 'punch' || !data) continue;

            try {
              const punch = JSON.parse(data) as LivePunch;
              merge([punch]);
              void resolveNames([punch.employeeId]);
            } catch {
              // Blok cacat dilewati; aliran tetap hidup.
            }
          }
        }
      } catch {
        // Termasuk pembatalan saat halaman ditinggalkan.
      }

      // Aliran berakhir tanpa halaman ditutup: turun ke polling alih-alih
      // membiarkan layar membeku diam-diam.
      if (mounted.current && !controller.signal.aborted) fallbackToPolling();
    })();

    return () => {
      mounted.current = false;
      controller.abort();
      if (poll) clearInterval(poll);
    };
  }, [api, loadSnapshot, merge, resolveNames]);

  const tone: Record<Connection, string> = {
    menyambung: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    langsung: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    berkala: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  };

  return (
    <AppShell>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dasbor Presensi Langsung</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Ketukan muncul di sini begitu tercatat. Tidak menampilkan koordinat
            maupun foto — dasbor hanya menerima status dan tanda.
          </p>
        </div>

        {/* Status koneksi ditampilkan, bukan disembunyikan. Dasbor yang membeku
            tanpa memberi tahu lebih berbahaya daripada dasbor yang mengaku
            datanya berumur semenit. */}
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone[connection]}`}>
          {connection === 'langsung'
            ? 'Terhubung langsung'
            : connection === 'berkala'
              ? 'Pembaruan berkala 20 detik'
              : 'Menyambung…'}
        </span>
      </header>

      {connection === 'berkala' && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Aliran langsung tidak tersedia — mungkin ditutup proxy jaringan Anda.
          Halaman tetap diperbarui setiap 20 detik.
        </p>
      )}

      {punches.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada ketukan sejak halaman ini dibuka.
          {connection === 'langsung' && ' Ketukan berikutnya akan muncul seketika.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Waktu</th>
                <th className="px-3 py-2 font-medium">Karyawan</th>
                <th className="px-3 py-2 font-medium">Jenis</th>
                <th className="px-3 py-2 font-medium">Sumber</th>
                <th className="px-3 py-2 font-medium">Skor</th>
              </tr>
            </thead>
            <tbody>
              {punches.map((punch) => {
                const employee = names.get(punch.employeeId);
                return (
                  <tr
                    key={punch.id}
                    className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {new Date(punch.punchedAt).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {employee?.fullName ?? '—'}{' '}
                      <span className="font-mono text-xs text-slate-400">
                        {employee?.employeeNumber}
                      </span>
                    </td>
                    <td className="px-3 py-2">{JENIS[punch.type] ?? punch.type}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{punch.source}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          punch.review === 'NEEDS_REVIEW'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {punch.trustScore}
                        {punch.review === 'NEEDS_REVIEW' && ' · perlu tinjauan'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {lastAt && (
        <p className="mt-3 text-xs text-slate-400">
          Pembaruan terakhir {lastAt.toLocaleTimeString('id-ID')}
        </p>
      )}
    </AppShell>
  );
}
