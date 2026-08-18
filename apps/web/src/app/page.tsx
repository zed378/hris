'use client';

import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

const ALL_MODULES = [
  { code: 'employee', label: 'Data Karyawan' },
  { code: 'attendance', label: 'Presensi' },
  { code: 'leave', label: 'Cuti' },
  { code: 'payroll', label: 'Penggajian' },
];

export default function HomePage() {
  const { bootstrap, hasModule } = useSession();

  return (
    <AppShell>
      <h1 className="text-xl font-semibold">Beranda</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Selamat datang, {bootstrap?.user.fullName}.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-600 dark:text-slate-300">Modul</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ALL_MODULES.map((module) => {
            const active = hasModule(module.code);
            return (
              <a
                key={module.code}
                href={active ? '#' : `/modules/${module.code}`}
                className={`rounded-lg border p-4 transition ${
                  active
                    ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                    : 'border-dashed border-slate-300 bg-slate-100/60 hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900/40'
                }`}
              >
                <p className="font-medium">{module.label}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {active ? 'Aktif' : 'Belum termasuk paket — klik untuk detail'}
                </p>
              </a>
            );
          })}
        </div>
      </section>

      <p className="mt-8 text-xs text-slate-400">
        Fase 1 selesai. Modul karyawan menyusul di Fase 2 — lihat PLAN/12 §6.
      </p>
    </AppShell>
  );
}
