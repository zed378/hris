import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MenuNode } from '@hrms/contracts';
import { isPathActive, menuLeaves, overflowItems, pocketItems } from '../src/lib/mobile-menu.ts';

/**
 * Mobile navigation (PF-02, docs/UI-UX/09 §3).
 *
 * The derivation is tested on menus shaped like what `/api/me/bootstrap`
 * returns for the seeded EMPLOYEE and HR roles. The property that matters is
 * reachability: every destination the server sent is either in the bottom bar
 * or behind "Lainnya" — a destination in neither is a page the user can only
 * reach by typing its address, which on a phone means not at all (risk F6).
 */

const leaf = (code: string, label: string, path: string): MenuNode => ({
  code, label, path, icon: null, moduleCode: code.split('.')[0]!, children: [],
});
const group = (code: string, label: string, icon: string, children: MenuNode[]): MenuNode => ({
  code, label, path: null, icon, moduleCode: code, children,
});

/** What the seeded EMPLOYEE role is sent. */
const EMPLOYEE_MENU: MenuNode[] = [
  { ...leaf('home', 'Beranda', '/'), icon: 'home' },
  group('attendance', 'Presensi', 'clock', [
    leaf('attendance.punch', 'Absen Sekarang', '/attendance/punch'),
    leaf('attendance.me', 'Presensi Saya', '/attendance/me'),
    leaf('attendance.consent', 'Persetujuan Data', '/attendance/consent'),
  ]),
  group('leave', 'Cuti', 'calendar', [leaf('leave.me', 'Cuti Saya', '/leave/me')]),
  group('payroll', 'Penggajian', 'wallet', [leaf('payroll.payslips.me', 'Slip Gaji Saya', '/payroll/me')]),
];

/** An HR administrator: pocket pages plus desk pages. */
const HR_MENU: MenuNode[] = [
  ...EMPLOYEE_MENU,
  group('employees', 'Karyawan', 'users', [
    leaf('employees.list', 'Daftar Karyawan', '/employees'),
    leaf('employees.grid', 'Grid Karyawan', '/employees/grid'),
  ]),
  group('settings', 'Pengaturan', 'settings', [leaf('settings.roles', 'Peran & Hak Akses', '/settings/roles')]),
];

describe('mobile menu derivation', () => {
  it.each([
    ['EMPLOYEE', EMPLOYEE_MENU],
    ['HR', HR_MENU],
  ])('puts every %s destination in the bar or behind "Lainnya", exactly once', (_role, menu) => {
    const reachable = [...pocketItems(menu), ...overflowItems(menu)].map((l) => l.code).sort();
    expect(reachable).toEqual(menuLeaves(menu).map((l) => l.code).sort());
  });

  it('orders the bar by thumb reach, home first', () => {
    expect(pocketItems(EMPLOYEE_MENU).map((l) => l.code)).toEqual([
      'home', 'attendance.punch', 'attendance.me', 'leave.me', 'payroll.payslips.me',
    ]);
    expect(overflowItems(EMPLOYEE_MENU).map((l) => l.code)).toEqual(['attendance.consent']);
  });

  it('gives a tenant without payroll a shorter bar, not a broken one', () => {
    const withoutPayroll = EMPLOYEE_MENU.filter((node) => node.code !== 'payroll');
    expect(pocketItems(withoutPayroll).map((l) => l.code)).not.toContain('payroll.payslips.me');
  });

  it('gives each leaf its group icon when it has none of its own', () => {
    const icons = Object.fromEntries(menuLeaves(EMPLOYEE_MENU).map((l) => [l.code, l.icon]));
    expect(icons).toMatchObject({ 'home': 'home', 'attendance.punch': 'clock', 'leave.me': 'calendar', 'payroll.payslips.me': 'wallet' });
  });

  it('never treats the root as a prefix of every page', () => {
    expect(isPathActive('/leave/me', '/')).toBe(false);
    expect(isPathActive('/', '/')).toBe(true);
    // A sub-page keeps its destination lit (§3 item 8).
    expect(isPathActive('/employees/grid', '/employees')).toBe(true);
    // A sibling sharing a prefix is not a child.
    expect(isPathActive('/employees-archive', '/employees')).toBe(false);
  });
});

/**
 * No second menu list (docs/UI-UX/03; PF-02 DoD).
 *
 * The menu is data. A list of menu paths written into a component or helper
 * rots silently the day the seed changes, and is exactly how a destination ends
 * up on the sidebar but not on the phone. Paths are read from the seed, never
 * restated here.
 *
 * A single path literal is allowed — a page linking to its neighbour ("Lihat
 * presensi saya") is not a menu. Two or more in one file outside the pages is a
 * list.
 */
describe('no second menu list', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const SEED = readFileSync(join(ROOT, '../../packages/db/prisma/seed.ts'), 'utf8');
  const MENU_PATHS = new Set([...SEED.matchAll(/path:\s*'(\/[^']*)'/g)].map((m) => m[1]!));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it('reads menu paths from the seed', () => {
    expect(MENU_PATHS.size).toBeGreaterThan(10);
  });

  it('finds no file in components or lib restating two or more menu paths', () => {
    const offenders: string[] = [];
    for (const file of [...sources(join(ROOT, 'src/components')), ...sources(join(ROOT, 'src/lib'))]) {
      const text = readFileSync(file, 'utf8');
      const found = new Set(
        [...text.matchAll(/['"`](\/[a-z0-9/-]*)['"`]/g)].map((m) => m[1]!).filter((p) => MENU_PATHS.has(p)),
      );
      if (found.size >= 2) offenders.push(`${relative(ROOT, file)}: ${[...found].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
