'use client';

import { use } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

const MODULE_LABELS: Record<string, { label: string; blurb: string }> = {
  employee: {
    label: 'Data Karyawan',
    blurb: 'Database karyawan, struktur organisasi, kontrak kerja, dan impor dari Excel.',
  },
  attendance: {
    label: 'Presensi',
    blurb: 'Kehadiran harian, shift, presensi berbasis lokasi dan foto, rekap periode.',
  },
  leave: {
    label: 'Cuti',
    blurb: 'Pengajuan dan persetujuan cuti, saldo, dan kalender tim.',
  },
  payroll: {
    label: 'Penggajian',
    blurb: 'Komponen gaji, PPh21 skema TER, BPJS, slip gaji, dan ekspor bank.',
  },
};

/**
 * Halaman modul terkunci.
 *
 * Muncul saat pengguna menjangkau modul yang tidak dilanggan tenantnya. Yang
 * penting di sini bukan tampilannya, melainkan apa yang TIDAK terjadi: halaman
 * ini tidak pernah menjadi jalan masuk. Endpoint modulnya tetap menolak dengan
 * 402 di gateway, terlepas dari apa pun yang dirender di sini (P9).
 *
 * Nadanya sengaja informatif, bukan menghalangi. Pengguna yang sampai ke sini
 * biasanya tidak tahu apa yang dibeli perusahaannya, dan menyalahkan mereka atas
 * itu tidak membantu siapa pun.
 */
export default function LockedModulePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { hasModule } = useSession();

  const module = MODULE_LABELS[code];
  const active = hasModule(code);

  return (
    <AppShell>
      <div className="mx-auto max-w-lg py-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-xl dark:bg-slate-800">
          {active ? '✓' : '🔒'}
        </div>

        <h1 className="text-xl font-semibold">{module?.label ?? code}</h1>

        {active ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Modul ini sudah aktif untuk perusahaan Anda, tetapi halamannya belum dibangun.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {module?.blurb ?? 'Modul ini belum termasuk dalam paket langganan perusahaan Anda.'}
            </p>
            <p className="mt-4 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              Hubungi pemilik akun perusahaan Anda untuk menambahkan modul ini.
              Seluruh data tetap tersimpan bila modul diaktifkan kemudian.
            </p>
          </>
        )}

        <Link
          href="/"
          className="mt-6 inline-block rounded-md border border-slate-300 px-4 py-2 text-sm transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Kembali ke beranda
        </Link>
      </div>
    </AppShell>
  );
}
