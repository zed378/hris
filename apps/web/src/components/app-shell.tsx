'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { MenuNode } from '@hrms/contracts';
import { useSession } from '@/lib/session.tsx';

/**
 * Kerangka aplikasi: penjagaan rute, sidebar dinamis, dan menu pengguna.
 *
 * Sidebar dirender sepenuhnya dari `/api/me/bootstrap` — tidak ada satu pun
 * daftar menu yang ditulis di frontend. Konsekuensinya, mengaktifkan modul di
 * control plane langsung mengubah navigasi tenant tanpa deploy.
 *
 * Perlu ditegaskan apa yang BUKAN dilakukan berkas ini: mengamankan apa pun.
 * Menu yang tidak dirender hanyalah kenyamanan. Setiap endpoint di baliknya
 * diperiksa ulang oleh gateway, dan bila keduanya berbeda, gateway yang benar (P9).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { status, bootstrap, logout } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated' || !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Memuat…
      </div>
    );
  }

  const { user, tenant, menu } = bootstrap;
  const trialDaysLeft =
    tenant.trialEndsAt !== null
      ? Math.ceil((new Date(tenant.trialEndsAt).getTime() - Date.now()) / 86_400_000)
      : null;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:block dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <p className="truncate font-semibold">{tenant.name}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {tenant.code} · paket {tenant.planCode}
          </p>
        </div>

        <nav className="space-y-1 p-3">
          {menu.map((node) => (
            <MenuItem key={node.code} node={node} depth={0} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
          {trialDaysLeft !== null && trialDaysLeft >= 0 ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Uji coba — sisa {trialDaysLeft} hari
            </span>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600 dark:text-slate-300">{user.fullName}</span>
            <button
              onClick={() => void logout()}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Keluar
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function MenuItem({ node, depth }: { node: MenuNode; depth: number }) {
  const pathname = usePathname();
  const active = node.path !== null && pathname === node.path;

  // Item grup (tanpa path) hanya membungkus anaknya. Server sudah menyaring grup
  // yang seluruh anaknya tidak terlihat, sehingga di sini tidak perlu diperiksa lagi.
  if (node.path === null) {
    return (
      <div className="pt-3">
        <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {node.label}
        </p>
        {node.children.map((child) => (
          <MenuItem key={child.code} node={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <>
      {/*
        prefetch dimatikan selama halaman modul belum dibangun.

        Menu berasal dari basis data dan sudah memuat rute Fase 2–5. Next akan
        mem-prefetch setiap tautan yang terlihat, sehingga satu kali muat
        beranda memicu 13 request yang semuanya 404 — pemborosan, sekaligus
        konsol yang penuh sehingga error sungguhan berikutnya akan tenggelam.

        Dilepas kembali ketika halamannya ada.
      */}
      <Link
        href={node.path}
        prefetch={false}
        className={`block rounded-md px-3 py-2 text-sm transition ${
          active
            ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        }`}
      >
        {node.label}
      </Link>
      {node.children.map((child) => (
        <MenuItem key={child.code} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
