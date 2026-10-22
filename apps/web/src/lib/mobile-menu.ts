import type { MenuNode } from '@hrms/contracts';

/**
 * Deriving the mobile navigation from bootstrap.menu (docs/UI-UX/09 section 3.2).
 *
 * The menu is data, not code (docs/UI-UX/03). Nothing here is a second menu
 * list: a code that the server did not send yields no item, and every label,
 * path, and icon still comes from the server. This module only decides which
 * of the destinations the server sent go in the bottom bar, and in what order.
 *
 * Menu node codes, never paths or labels. A path literal here would be the
 * second menu list the plan forbids, and it would rot silently the day a menu
 * is re-seeded.
 */

/** The pocket destinations, in the order docs/UI-UX/09 section 3.3 names them. */
const POCKET_CODES = [
    'home',
    'attendance.punch',
    'attendance.me',
    'leave.me',
    'payroll.payslips.me',
] as const;

/** A bottom bar holds five destinations plus "Lainnya". */
export const MAX_POCKET_ITEMS = 5;

export interface MenuLeaf {
    code: string;
    label: string;
    path: string;
    /**
     * The leaf's own icon, else its group's. Seeded leaves carry none — only the
     * groups do — and a bottom-bar item without an icon would be text-only
     * beside items that are not.
     */
    icon: string | null;
}

/** Every destination in the menu, in menu order. */
export function menuLeaves(menu: MenuNode[], groupIcon: string | null = null): MenuLeaf[] {
    const leaves: MenuLeaf[] = [];
    for (const node of menu) {
        if (node.path !== null) {
            leaves.push({ code: node.code, label: node.label, path: node.path, icon: node.icon ?? groupIcon });
        }
        if (node.children.length > 0) {
            // A node with a path can still have children (none is seeded today); its
            // children belong to the same group as it does.
            leaves.push(...menuLeaves(node.children, node.path === null ? (node.icon ?? groupIcon) : groupIcon));
        }
    }
    return leaves;
}

/**
 * The destinations the bottom bar shows.
 *
 * Ordered by POCKET_CODES, not by the menu, because the bottom bar is a
 * thumb-reach decision: punch first. A user whose tenant does not subscribe to
 * a module simply gets fewer items.
 */
export function pocketItems(menu: MenuNode[]): MenuLeaf[] {
    const leaves = menuLeaves(menu);
    const ordered: MenuLeaf[] = [];
    for (const code of POCKET_CODES) {
        const leaf = leaves.find((candidate) => candidate.code === code);
        if (leaf) ordered.push(leaf);
    }
    return ordered.slice(0, MAX_POCKET_ITEMS);
}

/**
 * Everything the bottom bar does not show, and therefore hides behind
 * "Lainnya". Empty means there is nothing to hide.
 */
export function overflowItems(menu: MenuNode[]): MenuLeaf[] {
    const shown = new Set(pocketItems(menu).map((leaf) => leaf.code));
    return menuLeaves(menu).filter((leaf) => !shown.has(leaf.code));
}

/**
 * Active state covers a destination's sub-pages, not only its exact path
 * (docs/UI-UX/09 section 3.8): /employees/grid keeps /employees lit.
 *
 * The root path is compared exactly: a prefix test on / would match every page
 * in the application.
 */
export function isPathActive(pathname: string, path: string): boolean {
    if (path === '/') return pathname === '/';
    return pathname === path || pathname.startsWith(`${path}/`);
}
