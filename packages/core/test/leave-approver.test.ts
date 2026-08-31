import { describe, expect, it } from 'vitest';
import type { TenantClient } from '@hrms/db';

import { findManagerUserId } from '../src/iam/resolve-access.ts';

/**
 * Finding the line manager's user account.
 *
 * `Employment.managerId` sat unread from the day the org module was built. It is
 * now the DEFAULT approver for that person's leave, which makes every way of
 * failing to resolve it worth naming — because each one is silent, and each one
 * produces the same visible result as "no manager was ever designated".
 *
 * The chain has three hops and any of them can legitimately come up empty:
 *
 *     employment (open period) → managerId → employee → email → user
 *
 * The employee → user hop is a join by EMAIL, not by key: the employee module
 * holds no foreign key into `auth.users` because the two are meant to be
 * separable (PLAN/01 §4.2). That makes it the hop most likely to break quietly,
 * and the one most worth pinning down here.
 */

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const EMPLOYEE = '00000000-0000-0000-0000-0000000000bb';
const MANAGER_EMPLOYEE = '00000000-0000-0000-0000-0000000000cc';
const MANAGER_USER = '00000000-0000-0000-0000-0000000000dd';

interface FakeShape {
  employment?: { managerId: string | null } | null;
  employee?: { email: string | null } | null;
  user?: { id: string } | null;
}

/**
 * A stand-in for the tenant client.
 *
 * Hand-written rather than mocked from the real client because what is under
 * test is a decision tree over three lookups, and the point of each test is
 * which lookup returned nothing. A fake makes that the only variable.
 */
function fakeTx(shape: FakeShape): TenantClient {
  return {
    employment: { findFirst: async () => shape.employment ?? null },
    employee: { findFirst: async () => shape.employee ?? null },
    user: { findFirst: async () => shape.user ?? null },
  } as unknown as TenantClient;
}

describe('findManagerUserId', () => {
  it('resolves the whole chain when every hop exists', async () => {
    const tx = fakeTx({
      employment: { managerId: MANAGER_EMPLOYEE },
      employee: { email: 'sari@demo.test' },
      user: { id: MANAGER_USER },
    });

    expect(await findManagerUserId(tx, TENANT, EMPLOYEE)).toBe(MANAGER_USER);
  });

  /**
   * The common case, and the reason the manager is a default rather than a
   * requirement. Most tenants never fill this column in; requiring it would
   * freeze every leave request they ever submit.
   */
  it('returns null when no manager has been designated', async () => {
    expect(await findManagerUserId(fakeTx({ employment: { managerId: null } }), TENANT, EMPLOYEE))
      .toBeNull();
  });

  it('returns null when the employee has no open employment period', async () => {
    expect(await findManagerUserId(fakeTx({ employment: null }), TENANT, EMPLOYEE)).toBeNull();
  });

  /**
   * A dangling soft reference. There is no foreign key on `managerId`, so an id
   * pointing at nothing is a state the database permits.
   */
  it('returns null when the manager employee row is gone', async () => {
    const tx = fakeTx({ employment: { managerId: MANAGER_EMPLOYEE }, employee: null });
    expect(await findManagerUserId(tx, TENANT, EMPLOYEE)).toBeNull();
  });

  /**
   * A manager who exists as an employee but has no login — common enough: a
   * supervisor on a factory floor who was imported from a spreadsheet and never
   * invited.
   */
  it('returns null when the manager has no email to join on', async () => {
    const tx = fakeTx({ employment: { managerId: MANAGER_EMPLOYEE }, employee: { email: null } });
    expect(await findManagerUserId(tx, TENANT, EMPLOYEE)).toBeNull();
  });

  it('returns null when the manager has no active user account', async () => {
    const tx = fakeTx({
      employment: { managerId: MANAGER_EMPLOYEE },
      employee: { email: 'sari@demo.test' },
      user: null,
    });

    expect(await findManagerUserId(tx, TENANT, EMPLOYEE)).toBeNull();
  });

  /**
   * Every failure produces the SAME answer, and that is the design rather than
   * an accident: the caller has exactly one fallback — let the requester choose
   * — and distinguishing "no manager set" from "the manager left" would only
   * offer it a decision it cannot act on differently.
   *
   * What must not happen is a throw. A missing manager is not an error; it is
   * the state most tenants are in, and raising here would break leave requests
   * for all of them.
   */
  it('never throws for any incomplete chain', async () => {
    const shapes: FakeShape[] = [
      {},
      { employment: null },
      { employment: { managerId: null } },
      { employment: { managerId: MANAGER_EMPLOYEE }, employee: null },
      { employment: { managerId: MANAGER_EMPLOYEE }, employee: { email: null } },
      { employment: { managerId: MANAGER_EMPLOYEE }, employee: { email: 'x@y.z' }, user: null },
    ];

    for (const shape of shapes) {
      await expect(findManagerUserId(fakeTx(shape), TENANT, EMPLOYEE)).resolves.toBeNull();
    }
  });
});
