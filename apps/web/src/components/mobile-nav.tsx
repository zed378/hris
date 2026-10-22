'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MenuNode } from '@hrms/contracts';
import { isPathActive, overflowItems, pocketItems } from '@/lib/mobile-menu.ts';

/**
 * Mobile navigation below `md` (PF-02, docs/UI-UX/09 §3): a bottom bar for the
 * pocket destinations and a drawer holding the full menu tree.
 *
 * Both render from `bootstrap.menu`, the same data as the desktop sidebar.
 * Which destinations go in the bar is decided in `lib/mobile-menu.ts` by menu
 * code; nothing here names a path. Like the sidebar, this is convenience, not
 * a control — the gateway refuses what the menu hides (P9).
 *
 * The drawer's open state lives in `AppShell`, because two triggers open it:
 * the header "Menu" button and the bar's "Lainnya".
 */

/** Outline icons for the seeded menu icons; an unknown name falls back to `home`. */
const ICON_PATHS: Record<string, string> = {
  home: 'M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  wallet: 'M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm13 5h2',
  users: 'M17 20h5v-2a4 4 0 00-5-3.87M9 20H2v-2a4 4 0 015-3.87m6-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a3 3 0 11-6 0 3 3 0 016 0z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 00-2-1.2L14.5 3h-4l-.4 2.6a7.3 7.3 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 002 1.2l.4 2.6h4l.4-2.6a7.3 7.3 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 18L18 6M6 6l12 12',
};

function NavIcon({ name }: { name: string | null }): ReactNode {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[name ?? 'home'] ?? ICON_PATHS['home']} />
    </svg>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function MobileNav({
  menu,
  drawerOpen,
  onOpenDrawer,
  onCloseDrawer,
  drawerTriggerRef,
}: {
  menu: MenuNode[];
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  /** Receives focus back when the drawer closes, if nothing else claimed it. */
  drawerTriggerRef: RefObject<HTMLElement | null>;
}) {
  const pathname = usePathname();
  const pocket = pocketItems(menu);
  const hasOverflow = overflowItems(menu).length > 0;
  const drawerRef = useRef<HTMLDivElement>(null);

  // Navigating from inside the drawer closes it. Keyed on the path, so opening
  // the drawer does not immediately close it again.
  const openPath = useRef(pathname);
  useEffect(() => {
    if (drawerOpen && openPath.current !== pathname) onCloseDrawer();
    openPath.current = pathname;
  }, [pathname, drawerOpen, onCloseDrawer]);

  // While open: focus moves in, Tab is trapped, Esc closes, the page behind does
  // not scroll. On close, focus returns to whatever opened it (§3 item 9).
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const returnTo = (document.activeElement as HTMLElement | null) ?? drawerTriggerRef.current;
    drawer.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      // Queried per keystroke: the tree can change while the drawer is open.
      const items = [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      (returnTo ?? drawerTriggerRef.current)?.focus();
    };
  }, [drawerOpen, onCloseDrawer, drawerTriggerRef]);

  return (
    <>
      <nav
        aria-label="Navigasi utama"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden dark:border-slate-800 dark:bg-slate-900"
      >
        <ul className="flex">
          {pocket.map((item) => {
            // A prefix match keeps the item lit on its sub-pages (§3 item 8). Not
            // the whole group: "Absen" and "Presensi Saya" share one, and lighting
            // both says nothing about where the user is.
            const active = isPathActive(pathname, item.path);
            return (
              <li key={item.code} className="min-w-0 flex-1">
                <Link
                  href={item.path}
                  prefetch={false}
                  aria-current={active ? 'page' : undefined}
                  className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-center text-[11px] leading-tight ${
                    active ? 'font-semibold text-brand-700 dark:text-brand-100' : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <NavIcon name={item.icon} />
                  <span className="line-clamp-2">{item.label}</span>
                </Link>
              </li>
            );
          })}
          {hasOverflow && (
            <li className="min-w-0 flex-1">
              <button
                type="button"
                onClick={onOpenDrawer}
                aria-expanded={drawerOpen}
                aria-controls="mobile-drawer"
                className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] leading-tight text-slate-600 dark:text-slate-300"
              >
                <NavIcon name="menu" />
                <span>Lainnya</span>
              </button>
            </li>
          )}
        </ul>
      </nav>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-900/50" aria-hidden="true" onClick={onCloseDrawer} />
          <div
            ref={drawerRef}
            id="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:bg-slate-900"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-800">
              <p className="font-semibold">Menu</p>
              <button
                type="button"
                onClick={onCloseDrawer}
                aria-label="Tutup menu"
                className="flex h-11 w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <NavIcon name="close" />
              </button>
            </div>
            <nav aria-label="Semua menu" className="flex-1 overflow-y-auto p-3">
              {menu.map((node) => (
                <DrawerItem key={node.code} node={node} pathname={pathname} />
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

/** The same grouping as the sidebar, with 44 px rows. */
function DrawerItem({ node, pathname }: { node: MenuNode; pathname: string }) {
  if (node.path === null) {
    return (
      <div className="pt-3">
        <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {node.label}
        </p>
        {node.children.map((child) => (
          <DrawerItem key={child.code} node={child} pathname={pathname} />
        ))}
      </div>
    );
  }

  const active = isPathActive(pathname, node.path);
  return (
    <>
      <Link
        href={node.path}
        prefetch={false}
        aria-current={active ? 'page' : undefined}
        className={`flex min-h-11 items-center rounded-md px-3 text-sm ${
          active
            ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        }`}
      >
        {node.label}
      </Link>
      {node.children.map((child) => (
        <DrawerItem key={child.code} node={child} pathname={pathname} />
      ))}
    </>
  );
}
