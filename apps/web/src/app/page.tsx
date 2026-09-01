'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell.tsx';
import { TrendChart } from '@/components/trend-chart.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Beranda — dasbor tiga cakupan (dokumen 07 §5, PLAN/12 F6).
 *
 * Aturan yang menentukan apa yang muncul di sini: **setiap angka harus punya
 * tempat untuk ditindaklanjuti.** "Presensi ditandai: 7" berguna karena ada
 * antrean tinjauan untuk membukanya. "Total karyawan: 143" hanya berguna sekali,
 * pada hari pertama seseorang melihatnya, lalu menjadi hiasan.
 *
 * Karena itu hampir setiap kartu di bawah adalah tautan, dan yang bukan tautan
 * ada karena ia menjawab pertanyaan yang benar-benar ditanyakan orang setiap
 * pagi: apakah saya sudah absen, berapa sisa cuti saya.
 *
 * Modul yang tidak aktif tidak menghasilkan kartu kosong. Angka nol pada modul
 * yang tidak dilanggan bukan informasi — ia salah paham yang menunggu terjadi.
 */

interface Dashboard {
  workDate: string;
  own: {
    todayPunches: Array<{ type: string; punchedAt: string }> | null;
    leaveBalances: Array<{ code: string; name: string; available: number }> | null;
    pendingLeaveRequests: number | null;
    latestPayslip: { periodYear: number; periodMonth: number; net: number } | null;
  } | null;
  team: { pendingLeaveApprovals: number | null } | null;
  tenant: {
    activeEmployees: number;
    presentToday: number | null;
    flaggedPunches: number | null;
    flaggedRatio: number | null;
    pendingLeaveRequests: number | null;
    employeesOnLeaveToday: number | null;
    expiringContracts: number | null;
    payrollRunsPendingApproval: number | null;
  } | null;
}

interface Trends {
  months: string[];
  attendance: Array<{
    month: string;
    punches: number;
    flagged: number;
    flaggedRatio: number | null;
    absentDays: number;
    lateDays: number;
    presentDays: number;
  }> | null;
  leave: Array<{ month: string; days: number; requests: number }> | null;
}

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const rupiah = (value: number): string =>
  new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(value);

const jam = (iso: string): string =>
  new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

/** Kartu angka yang mengarah ke tempat menindaklanjutinya. */
function Kartu({
  label,
  value,
  hint,
  href,
  tone = 'netral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: 'netral' | 'perhatian';
}) {
  const isi = (
    <>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && (
        <p
          className={`mt-1 text-xs ${
            tone === 'perhatian'
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {hint}
        </p>
      )}
    </>
  );

  const kelas = `block rounded-lg border p-4 ${
    tone === 'perhatian'
      ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
      : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
  } ${href ? 'transition hover:border-brand-400' : ''}`;

  return href ? (
    <Link href={href} className={kelas} prefetch={false}>
      {isi}
    </Link>
  ) : (
    <div className={kelas}>{isi}</div>
  );
}

export default function HomePage() {
  const { bootstrap, api } = useSession();
  const [data, setData] = useState<Dashboard | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/dashboard');
      if (response.ok) setData((await response.json()) as Dashboard);
      setLoading(false);
    })();
  }, [api]);

  /**
   * Trends are fetched separately, and after the summary.
   *
   * The summary is what the screen needs before it can show anything; three
   * grouped queries over six months are not. A 403 here is the ordinary answer
   * for a user without the tenant-wide permission, so it is left silent — the
   * section simply does not appear, which is what P9 asks of a screen.
   */
  useEffect(() => {
    void (async () => {
      const response = await api('/api/dashboard/trends?months=6');
      if (response.ok) setTrends((await response.json()) as Trends);
    })();
  }, [api]);

  const own = data?.own;
  const tenant = data?.tenant;
  const team = data?.team;

  const masuk = own?.todayPunches?.find((p) => p.type === 'IN');
  const pulang = [...(own?.todayPunches ?? [])].reverse().find((p) => p.type === 'OUT');

  // Ambang 12% dari PLAN/12 §11. Di atas itu, HR berhenti meninjau dan skor
  // kepercayaan berubah menjadi teater.
  const rasioTinggi = (tenant?.flaggedRatio ?? 0) > 0.12;

  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-xl font-semibold">
          Selamat datang, {bootstrap?.user.fullName?.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {data?.workDate &&
            new Date(`${data.workDate}T00:00:00Z`).toLocaleDateString('id-ID', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })}
        </p>
      </header>

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      {own && (own.todayPunches !== null || own.leaveBalances !== null) && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600 dark:text-slate-300">
            Hari ini
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {own.todayPunches !== null && (
              <Kartu
                label="Presensi Anda"
                value={masuk ? jam(masuk.punchedAt) : '—'}
                hint={
                  masuk
                    ? pulang
                      ? `pulang ${jam(pulang.punchedAt)}`
                      : 'belum absen pulang'
                    : 'belum absen masuk'
                }
                href="/attendance/punch"
                tone={masuk ? 'netral' : 'perhatian'}
              />
            )}

            {own.leaveBalances?.map((balance) => (
              <Kartu
                key={balance.code}
                label={balance.name}
                value={balance.available}
                hint="hari tersedia"
                href="/leave/me"
              />
            ))}

            {own.pendingLeaveRequests !== null && own.pendingLeaveRequests > 0 && (
              <Kartu
                label="Pengajuan cuti Anda"
                value={own.pendingLeaveRequests}
                hint="menunggu keputusan"
                href="/leave/me"
              />
            )}

            {own.latestPayslip && (
              <Kartu
                label={`Slip ${BULAN[own.latestPayslip.periodMonth - 1]}`}
                value={rupiah(own.latestPayslip.net)}
                hint="gaji bersih"
                href="/payroll/me"
              />
            )}
          </div>
        </section>
      )}

      {team && team.pendingLeaveApprovals !== null && team.pendingLeaveApprovals > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600 dark:text-slate-300">
            Menunggu keputusan Anda
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kartu
              label="Pengajuan cuti"
              value={team.pendingLeaveApprovals}
              hint="belum diputuskan"
              href="/leave/approvals"
              tone="perhatian"
            />
          </div>
        </section>
      )}

      {tenant && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600 dark:text-slate-300">
            Perusahaan
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kartu
              label="Karyawan aktif"
              value={tenant.activeEmployees}
              href="/employees"
            />

            {tenant.presentToday !== null && (
              <Kartu
                label="Sudah absen masuk"
                value={tenant.presentToday}
                hint={`dari ${tenant.activeEmployees} karyawan`}
                href="/attendance/live"
              />
            )}

            {tenant.employeesOnLeaveToday !== null && tenant.employeesOnLeaveToday > 0 && (
              <Kartu
                label="Sedang cuti"
                value={tenant.employeesOnLeaveToday}
                hint="hari ini"
                href="/leave/calendar"
              />
            )}

            {tenant.flaggedPunches !== null && tenant.flaggedPunches > 0 && (
              <Kartu
                label="Presensi ditandai"
                value={tenant.flaggedPunches}
                hint={
                  rasioTinggi
                    ? `${((tenant.flaggedRatio ?? 0) * 100).toFixed(1)}% — ambang mungkin terlalu ketat`
                    : 'menunggu tinjauan'
                }
                href="/attendance/review"
                tone={rasioTinggi ? 'perhatian' : 'netral'}
              />
            )}

            {tenant.pendingLeaveRequests !== null && tenant.pendingLeaveRequests > 0 && (
              <Kartu
                label="Cuti menunggu"
                value={tenant.pendingLeaveRequests}
                hint="belum diputuskan siapa pun"
                href="/leave/approvals"
              />
            )}

            {tenant.expiringContracts !== null && tenant.expiringContracts > 0 && (
              <Kartu
                label="Kontrak berakhir"
                value={tenant.expiringContracts}
                hint="dalam 90 hari"
                href="/employees/contracts"
                tone="perhatian"
              />
            )}

            {tenant.payrollRunsPendingApproval !== null &&
              tenant.payrollRunsPendingApproval > 0 && (
                <Kartu
                  label="Penggajian menunggu"
                  value={tenant.payrollRunsPendingApproval}
                  hint="sudah dihitung, belum disetujui"
                  href="/payroll/runs"
                  tone="perhatian"
                />
              )}
          </div>
        </section>
      )}


      {trends && (trends.attendance || trends.leave) && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-medium">Tren enam bulan</h2>
          <p className="mb-4 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            Satu bulan tidak dapat menjawab satu-satunya pertanyaan yang penting
            dari angka-angka ini: apakah keadaannya memburuk. Rasio 9% wajar;
            rasio 9% setelah tiga bulan di 4% adalah hal yang sama sekali lain.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {trends.attendance && (
              <>
                <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <h3 className="text-sm font-medium">Rasio presensi ditandai</h3>
                  <p className="mb-2 text-xs text-slate-500">
                    Di atas 12% HR berhenti meninjau dan skor kepercayaan menjadi
                    teater (PLAN/12 §11). Ambangnya belum dikalibrasi — grafik
                    inilah yang memungkinkan kalibrasinya.
                  </p>
                  <TrendChart
                    points={trends.attendance.map((p) => ({
                      label: p.month,
                      value: p.flaggedRatio,
                    }))}
                    format={(v) => `${(v * 100).toFixed(1)}%`}
                    threshold={0.12}
                    thresholdLabel="12%"
                  />
                </div>

                <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <h3 className="text-sm font-medium">Hari tidak hadir</h3>
                  <p className="mb-2 text-xs text-slate-500">
                    Tanpa keterangan. Kenaikannya adalah persoalan yang tidak
                    muncul di mana pun sampai penggajian.
                  </p>
                  <TrendChart
                    points={trends.attendance.map((p) => ({
                      label: p.month,
                      value: p.absentDays,
                    }))}
                    format={(v) => `${v} hari`}
                  />
                </div>
              </>
            )}

            {trends.leave && (
              <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                <h3 className="text-sm font-medium">Hari cuti diambil</h3>
                <p className="mb-2 text-xs text-slate-500">
                  Hanya yang disetujui. Cuti bersifat musiman, dan yang menyetujui
                  pengajuan Desember perlu tahu Desember biasanya seperti apa.
                </p>
                <TrendChart
                  points={trends.leave.map((p) => ({ label: p.month, value: p.days }))}
                  format={(v) => `${v} hari`}
                />
              </div>
            )}
          </div>
        </section>
      )}

      {!loading && !own?.todayPunches && !tenant && (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Akun Anda belum terhubung ke data karyawan. Hubungi admin HR untuk
          menghubungkannya, agar presensi dan cuti Anda muncul di sini.
        </p>
      )}
    </AppShell>
  );
}
