'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Shift dan jadwal kerja (dokumen 10 §5).
 *
 * Menu "Shift & Jadwal" sudah ada di basis data sejak seed pertama dan sudah
 * tampil bagi setiap HR yang membuka sidebar — menuju halaman yang tidak pernah
 * ada. Halaman ini yang mengisinya.
 *
 * Yang dikerjakan di sini bukan kenyamanan. Tabel `attendance.schedules` dibaca
 * dua modul — presensi memakainya untuk memutuskan status `DAY_OFF`, cuti untuk
 * menghitung hari kerja — tetapi tidak ada satu pun yang mengisinya, sehingga
 * keduanya jatuh ke anggapan Senin–Jumat. Anggapan itu salah untuk sebagian
 * besar tenant yang dituju produk ini: pabrik enam hari kerja, ritel yang libur
 * hari Senin, satpam tiga shift yang liburnya berputar.
 *
 * Pada pabrik enam hari, pengajuan cuti Senin–Sabtu memotong lima hari saldo
 * untuk enam hari kerja yang ditinggalkan. Perusahaan kehilangan satu hari
 * setiap kali, dan angkanya tetap masuk akal sehingga tidak ada yang
 * menyadarinya.
 */

interface Shift {
  id: string;
  code: string;
  name: string;
  start: string;
  end: string;
  crossesMidnight: boolean;
  graceMinutes: number;
  breakMinutes: number;
}

interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
}

interface GenerateResult {
  created: number;
  updated: number;
  skipped: number;
  outsideEmployment: number;
  employees: number;
}

const HARI = [
  { value: 0, label: 'Minggu' },
  { value: 1, label: 'Senin' },
  { value: 2, label: 'Selasa' },
  { value: 3, label: 'Rabu' },
  { value: 4, label: 'Kamis' },
  { value: 5, label: 'Jumat' },
  { value: 6, label: 'Sabtu' },
] as const;

/** Pola siap pakai. Yang paling sering dipakai tidak boleh menuntut sepuluh klik. */
const POLA = [
  { label: 'Senin–Jumat', dayOffs: [0, 6] },
  { label: 'Senin–Sabtu (pabrik)', dayOffs: [0] },
  { label: 'Libur Senin (ritel)', dayOffs: [1] },
  { label: 'Tujuh hari (shift berputar)', dayOffs: [] },
] as const;

export default function ShiftsPage() {
  const { api } = useSession();

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dayOffs, setDayOffs] = useState<number[]>([0, 6]);
  const [shiftId, setShiftId] = useState<string>('');
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [shiftRes, empRes] = await Promise.all([
      api('/api/attendance/shifts'),
      api('/api/employees?limit=500&status=ACTIVE'),
    ]);
    if (shiftRes.ok) setShifts(((await shiftRes.json()) as { shifts: Shift[] }).shifts);
    if (empRes.ok) setEmployees(((await empRes.json()) as { employees: Employee[] }).employees);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const hariKerjaSeminggu = useMemo(() => 7 - dayOffs.length, [dayOffs]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);

    const response = await api('/api/attendance/schedules', {
      method: 'POST',
      body: JSON.stringify({
        employeeIds: [...selected],
        from,
        to,
        shiftId: shiftId || null,
        dayOffWeekdays: dayOffs,
        overwrite,
      }),
    });

    if (response.ok) {
      setResult((await response.json()) as GenerateResult);
    } else {
      const json = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(json?.message ?? 'Pembangkitan jadwal gagal');
    }
    setBusy(false);
  }, [api, selected, from, to, shiftId, dayOffs, overwrite]);

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Shift &amp; Jadwal</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Jadwal menentukan hari mana yang terhitung hari kerja — bagi presensi
        maupun bagi pemotongan saldo cuti. Selama seorang karyawan belum
        dijadwalkan, sistem menganggapnya bekerja Senin–Jumat.
      </p>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Shift</h2>
        {loading ? (
          <p className="mt-2 text-sm text-slate-500">Memuat…</p>
        ) : shifts.length === 0 ? (
          <p className="mt-2 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Belum ada shift. Jadwal tetap dapat dibangkitkan tanpa shift — hari
            kerja dan hari libur tetap tercatat — tetapi keterlambatan tidak
            dapat dihitung tanpa jam masuk.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2 pr-6">Kode</th>
                  <th className="py-2 pr-6">Nama</th>
                  <th className="py-2 pr-6">Jam</th>
                  <th className="py-2 pr-6">Toleransi</th>
                  <th className="py-2">Istirahat</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-2 pr-6 font-mono text-xs">{s.code}</td>
                    <td className="py-2 pr-6">{s.name}</td>
                    <td className="py-2 pr-6">
                      {s.start}–{s.end}
                      {s.crossesMidnight && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-700">
                          lewat tengah malam
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-6">{s.graceMinutes} menit</td>
                    <td className="py-2">{s.breakMinutes} menit</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10 max-w-4xl">
        <h2 className="text-lg font-medium">Bangkitkan jadwal</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-slate-600 dark:text-slate-400">Dari tanggal</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 dark:text-slate-400">Sampai tanggal</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </div>

        <div className="mt-4">
          <p className="text-sm text-slate-600 dark:text-slate-400">Pola siap pakai</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {POLA.map((p) => (
              <button
                key={p.label}
                onClick={() => setDayOffs([...p.dayOffs])}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  p.dayOffs.length === dayOffs.length &&
                  p.dayOffs.every((d) => dayOffs.includes(d))
                    ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100'
                    : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm text-slate-600 dark:text-slate-400">
            Hari libur mingguan — {hariKerjaSeminggu} hari kerja seminggu
          </legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {HARI.map((h) => (
              <label key={h.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dayOffs.includes(h.value)}
                  onChange={(e) =>
                    setDayOffs((prev) =>
                      e.target.checked
                        ? [...prev, h.value]
                        : prev.filter((d) => d !== h.value),
                    )
                  }
                />
                {h.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-4 block text-sm">
          <span className="block text-slate-600 dark:text-slate-400">Shift untuk hari masuk</span>
          <select
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900 sm:w-80"
          >
            <option value="">Tanpa shift tetap</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.start}–{s.end})
              </option>
            ))}
          </select>
        </label>

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Karyawan — {selected.size} dipilih
            </p>
            <div className="flex gap-3 text-sm">
              <button
                onClick={() => setSelected(new Set(employees.map((e) => e.id)))}
                className="text-brand-600 underline"
              >
                Pilih semua
              </button>
              <button onClick={() => setSelected(new Set())} className="text-brand-600 underline">
                Kosongkan
              </button>
            </div>
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
            {employees.map((e) => (
              <label key={e.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(e.id)}
                  onChange={(ev) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (ev.target.checked) next.add(e.id);
                      else next.delete(e.id);
                      return next;
                    })
                  }
                />
                <span className="font-mono text-xs text-slate-500">{e.employeeNumber}</span>
                {e.fullName}
              </label>
            ))}
          </div>
        </div>

        {/*
          Menimpa harus diminta, tidak pernah menjadi default. Baris jadwal yang
          sudah ada mungkin hasil penyesuaian tangan — tukar shift antar-karyawan,
          libur pengganti yang sudah disepakati — dan menghapusnya diam-diam
          adalah cara kehilangan kepercayaan pada penjadwalan dalam satu kali pakai.
        */}
        <label className="mt-6 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="mt-1"
          />
          <span>
            Timpa jadwal yang sudah ada
            <span className="block text-slate-500">
              Tanpa ini, tanggal yang sudah punya jadwal dilewati dan dilaporkan.
              Penyesuaian tangan — tukar shift, libur pengganti — tidak hilang.
            </span>
          </span>
        </label>

        <button
          onClick={() => void generate()}
          disabled={busy || selected.size === 0}
          className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Membangkitkan…' : 'Bangkitkan jadwal'}
        </button>

        {error && (
          <p className="mt-3 rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}

        {result && (
          <div className="mt-3 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <p>
              {result.created} jadwal dibuat, {result.updated} diperbarui untuk{' '}
              {result.employees} karyawan.
            </p>
            {result.skipped > 0 && (
              <p className="mt-1">
                {result.skipped} tanggal dilewati karena sudah punya jadwal. Centang
                &ldquo;timpa&rdquo; bila memang ingin menggantinya.
              </p>
            )}
            {result.outsideEmployment > 0 && (
              // Disebut eksplisit, bukan didiamkan. Karyawan yang resign tetapi
              // punya jadwal sampai akhir tahun akan tercatat ALFA setiap hari,
              // dan angka kehadiran seluruh perusahaan ikut rusak.
              <p className="mt-1">
                {result.outsideEmployment} tanggal di luar masa kerja tidak
                dijadwalkan — sebelum tanggal masuk atau setelah tanggal keluar.
              </p>
            )}
          </div>
        )}
      </section>
    </AppShell>
  );
}
