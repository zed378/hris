'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { downloadFile, type DownloadOutcome } from '@/lib/download.ts';

/**
 * Rekap kehadiran dan koreksi manual (dokumen 10 §6).
 *
 * Dua hal digabung dalam satu layar dengan sengaja. Rekap adalah tempat HR
 * MELIHAT ada yang salah — sebuah hari kosong, jam pulang yang tidak masuk akal.
 * Formulir koreksi adalah tempat ia MEMPERBAIKINYA. Memisahkannya ke dua menu
 * berarti setiap perbaikan dimulai dengan mengingat nomor karyawan dan tanggal
 * dari layar sebelumnya, dan ingatan itulah yang salah.
 *
 * Yang tidak ada di sini: menyunting jam pada ketukan yang sudah tersimpan.
 * Catatan presensi tidak pernah ditimpa (P13). Ketukan yang salah ditolak lewat
 * antrean tinjauan; yang hilang ditambahkan sebagai baris baru bersumber MANUAL.
 * Riwayatnya jadi lebih panjang, dan justru itu gunanya saat ada sengketa upah.
 */

interface DayRow {
  id: string;
  workDate: string;
  employee: { id: string; employeeNumber: string; fullName: string } | null;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  isLocked: boolean;
}

interface EmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
}

const STATUS_LABEL: Record<string, string> = {
  PRESENT: 'Hadir',
  LATE: 'Terlambat',
  ABSENT: 'Tidak hadir',
  LEAVE: 'Cuti',
  HOLIDAY: 'Libur',
  DAY_OFF: 'Hari libur',
};

const STATUS_TONE: Record<string, string> = {
  PRESENT: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  LATE: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  ABSENT: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

const NEUTRAL_TONE = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function hhmm(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function durasi(minutes: number): string {
  if (minutes <= 0) return '—';
  return `${Math.floor(minutes / 60)}j ${String(minutes % 60).padStart(2, '0')}m`;
}

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
] as const;

interface MonthlyRow {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  hadir: number;
  terlambat: number;
  alfa: number;
  cuti: number;
  hariTercatat: number;
  menitTerlambat: number;
  menitLembur: number;
  jamKerja: number;
}

interface MonthlyReport {
  periodYear: number;
  periodMonth: number;
  hariKalender: number;
  rows: MonthlyRow[];
  totals: {
    karyawan: number;
    hadir: number;
    terlambat: number;
    alfa: number;
    cuti: number;
    menitTerlambat: number;
    menitLembur: number;
  };
  tanpaData: Array<{ employeeNumber: string; fullName: string }>;
}

export default function RecordsPage() {
  const { api } = useSession();

  const [rekap, setRekap] = useState<MonthlyReport | null>(null);
  const [rekapPeriode, setRekapPeriode] = useState(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  });
  const [rekapBusy, setRekapBusy] = useState(false);

  const [unduhan, setUnduhan] = useState<DownloadOutcome | null>(null);
  const [unduhBusy, setUnduhBusy] = useState(false);

  /**
   * Rekap bulanan — satu baris per karyawan.
   *
   * Dimuat atas permintaan, bukan otomatis bersama halaman. Agregasinya menyapu
   * seluruh baris presensi sebulan, dan HR yang membuka halaman ini untuk
   * mengoreksi satu ketukan tidak perlu menunggu perhitungan seratus karyawan.
   */
  const muatRekap = useCallback(async () => {
    setRekapBusy(true);
    const response = await api(
      `/api/reports/attendance-monthly?year=${rekapPeriode.year}&month=${rekapPeriode.month}`,
    );
    if (response.ok) setRekap((await response.json()) as MonthlyReport);
    setRekapBusy(false);
  }, [api, rekapPeriode]);

  const unduh = useCallback(
    async (path: string, nama: string) => {
      setUnduhBusy(true);
      setUnduhan(await downloadFile(api, path, nama));
      setUnduhBusy(false);
    },
    [api],
  );
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [days, setDays] = useState<DayRow[]>([]);
  const [summary, setSummary] = useState({ present: 0, late: 0, absent: 0 });
  const [loading, setLoading] = useState(true);

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [form, setForm] = useState({
    employeeId: '',
    type: 'IN',
    date: today(),
    time: '08:00',
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api(`/api/attendance/records?from=${from}&to=${to}`);
    if (response.ok) {
      const json = (await response.json()) as {
        days: DayRow[];
        summary: { present: number; late: number; absent: number };
      };
      setDays(json.days);
      setSummary(json.summary);
    }
    setLoading(false);
  }, [api, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/employees?limit=500&status=ACTIVE');
      if (!response.ok) return;
      const json = (await response.json()) as { employees?: EmployeeOption[] };
      setEmployees(json.employees ?? []);
    })();
  }, [api]);

  const submitManual = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    // Waktu dari formulir dibaca sebagai waktu LOKAL pengguna, lalu dikirim
    // sebagai ISO. `new Date('2026-08-18T08:00')` tanpa penanda zona memakai
    // zona peramban — dan itulah yang dimaksud HR ketika ia mengetik "08:00".
    const punchedAt = new Date(`${form.date}T${form.time}`);

    const response = await api('/api/attendance/manual-punch', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: form.employeeId,
        type: form.type,
        punchedAt: punchedAt.toISOString(),
        reason: form.reason.trim(),
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as { duplicate?: boolean; dayRecalculated?: boolean };
      setMessage({
        tone: 'ok',
        text: json.duplicate
          ? 'Ketukan ini sudah pernah dimasukkan. Tidak ada baris ganda yang dibuat.'
          : json.dayRecalculated === false
            ? 'Ketukan tercatat, tetapi rekap harinya terkunci sehingga angkanya tidak berubah.'
            : 'Ketukan manual tercatat dan rekap harinya sudah dihitung ulang.',
      });
      setForm((f) => ({ ...f, reason: '' }));
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage({
        tone: 'error',
        text: json?.error?.message ?? 'Entri manual gagal disimpan.',
      });
    }

    setBusy(false);
  }, [api, form, load]);

  const canSubmit = useMemo(
    () => form.employeeId !== '' && form.reason.trim().length >= 4 && !busy,
    [form, busy],
  );

  return (
    <AppShell>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Rekap Kehadiran</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Angka di sini diturunkan dari ketukan presensi dan dapat dihitung ulang.
            Hari yang sudah terkunci penutupan periode tidak lagi berubah.
          </p>
        </div>

        {/* Rentang yang sedang terlihat ikut terbawa, sehingga yang terunduh
             persis yang tampil. Ekspor yang selalu mengambil semuanya adalah
             seluruh riwayat kehadiran setiap orang — berkas yang tidak
             dibutuhkan siapa pun dan tidak seharusnya beredar. */}
        <button
          onClick={() =>
            void unduh(
              `/api/attendance/records/export?from=${from}&to=${to}`,
              `presensi-${from}-sd-${to}.xlsx`,
            )
          }
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

      <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Rekap bulanan</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              value={rekapPeriode.year}
              onChange={(e) =>
                setRekapPeriode((p) => ({ ...p, year: Number(e.target.value) }))
              }
              className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <select
              value={rekapPeriode.month}
              onChange={(e) =>
                setRekapPeriode((p) => ({ ...p, month: Number(e.target.value) }))
              }
              className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {BULAN.map((nama, i) => (
                <option key={nama} value={i + 1}>
                  {nama}
                </option>
              ))}
            </select>
            <button
              onClick={() => void muatRekap()}
              disabled={rekapBusy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {rekapBusy ? 'Menghitung…' : 'Tampilkan'}
            </button>
            {rekap && (
              <button
                onClick={() =>
                  void unduh(
                    `/api/reports/attendance-monthly?year=${rekap.periodYear}&month=${rekap.periodMonth}&format=xlsx`,
                    `rekap-presensi-${rekap.periodYear}-${String(rekap.periodMonth).padStart(2, '0')}.xlsx`,
                  )
                }
                disabled={unduhBusy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Ekspor .xlsx
              </button>
            )}
          </div>
        </div>

        {rekap && (
          <>
            {/*
              Karyawan tanpa satu pun baris rekap disebut TERPISAH, bukan
              ditampilkan sebagai baris nol. Nol yang berasal dari "belum
              dihitung" dan nol yang berasal dari "memang tidak hadir" adalah dua
              hal yang sangat berbeda, dan menampilkannya sama akan membuat yang
              pertama terbaca sebagai yang kedua — lalu masuk ke potongan gaji.
            */}
            {rekap.tanpaData.length > 0 && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {rekap.tanpaData.length} karyawan belum punya satu pun baris rekap
                pada bulan ini — angkanya bukan nol, melainkan belum dihitung.
                Jalankan hitung ulang untuk tanggal-tanggal yang bersangkutan
                sebelum memakai rekap ini.
              </p>
            )}

            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Karyawan</th>
                    <th className="py-2 pr-4 text-right">Hadir</th>
                    <th className="py-2 pr-4 text-right">Terlambat</th>
                    <th className="py-2 pr-4 text-right">Alfa</th>
                    <th className="py-2 pr-4 text-right">Cuti</th>
                    <th className="py-2 pr-4 text-right">Menit telat</th>
                    <th className="py-2 pr-4 text-right">Menit lembur</th>
                    <th className="py-2 text-right">Jam kerja</th>
                  </tr>
                </thead>
                <tbody>
                  {rekap.rows.map((row) => (
                    <tr
                      key={row.employeeId}
                      className="border-t border-slate-200 dark:border-slate-800"
                    >
                      <td className="py-2 pr-4">
                        {row.fullName}
                        <span className="ml-2 font-mono text-xs text-slate-400">
                          {row.employeeNumber}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.hadir}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.terlambat}</td>
                      <td
                        className={`py-2 pr-4 text-right tabular-nums ${
                          row.alfa > 0 ? 'font-medium text-rose-700 dark:text-rose-400' : ''
                        }`}
                      >
                        {row.alfa}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.cuti}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.menitTerlambat}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.menitLembur}</td>
                      <td className="py-2 text-right tabular-nums">{row.jamKerja}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-medium dark:border-slate-700">
                    <td className="py-2 pr-4">{rekap.totals.karyawan} karyawan</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{rekap.totals.hadir}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{rekap.totals.terlambat}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{rekap.totals.alfa}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{rekap.totals.cuti}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {rekap.totals.menitTerlambat}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {rekap.totals.menitLembur}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">Koreksi manual</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Untuk ketukan yang tidak pernah terjadi — karyawan lupa, ponselnya mati,
          mesin absen rusak. Barisnya tercatat bersumber MANUAL dengan nama Anda
          dan alasannya, dan akan tetap terlihat begitu selamanya.
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <select
            value={form.employeeId}
            onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
            className={FIELD}
          >
            <option value="">Pilih karyawan…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNumber} — {employee.fullName}
              </option>
            ))}
          </select>

          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className={FIELD}
          >
            <option value="IN">Masuk</option>
            <option value="OUT">Pulang</option>
            <option value="BREAK_START">Mulai istirahat</option>
            <option value="BREAK_END">Selesai istirahat</option>
          </select>

          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            className={FIELD}
          />

          <input
            type="time"
            value={form.time}
            onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
            className={FIELD}
          />

          <button
            onClick={() => void submitManual()}
            disabled={!canSubmit}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Menyimpan…' : 'Simpan koreksi'}
          </button>
        </div>

        <input
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          placeholder="Alasan koreksi (wajib, minimal 4 karakter)"
          className={`mt-2 w-full ${FIELD}`}
        />

        {message && (
          <p
            className={`mt-2 rounded-md px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500 dark:text-slate-400">Dari</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={FIELD}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500 dark:text-slate-400">Sampai</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
        </label>

        <div className="ml-auto flex gap-3 text-sm text-slate-500 dark:text-slate-400">
          <span>Hadir {summary.present}</span>
          <span>Terlambat {summary.late}</span>
          <span>Tidak hadir {summary.absent}</span>
        </div>
      </div>

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {!loading && days.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada rekap pada rentang ini. Rekap dibentuk saat hari dihitung —
          gunakan koreksi manual di atas bila ketukannya memang tidak pernah ada.
        </p>
      )}

      {days.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Tanggal</th>
                <th className="px-3 py-2 font-medium">Karyawan</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Masuk</th>
                <th className="px-3 py-2 font-medium">Pulang</th>
                <th className="px-3 py-2 font-medium">Telat</th>
                <th className="px-3 py-2 font-medium">Kerja</th>
                <th className="px-3 py-2 font-medium">Lembur</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr
                  key={day.id}
                  className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    {day.workDate}
                    {/* Hari terkunci ditandai di barisnya, bukan hanya ditolak
                        ketika koreksi gagal. HR perlu tahu sebelum mencoba. */}
                    {day.isLocked && (
                      <span className="ml-1.5 text-xs text-slate-400" title="Periode sudah ditutup">
                        terkunci
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {day.employee?.fullName ?? '—'}{' '}
                    <span className="font-mono text-xs text-slate-400">
                      {day.employee?.employeeNumber}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_TONE[day.status] ?? NEUTRAL_TONE
                      }`}
                    >
                      {STATUS_LABEL[day.status] ?? day.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{hhmm(day.checkIn)}</td>
                  <td className="px-3 py-2 tabular-nums">{hhmm(day.checkOut)}</td>
                  <td className="px-3 py-2 tabular-nums">{durasi(day.lateMinutes)}</td>
                  <td className="px-3 py-2 tabular-nums">{durasi(day.workMinutes)}</td>
                  <td className="px-3 py-2 tabular-nums">{durasi(day.overtimeMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
