import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { withTenant, disconnectAll } from '@hrms/db';
import { buildTrends, MAX_TREND_MONTHS } from '../src/dashboard/trends.ts';

/**
 * Month-over-month trends, against a real database.
 *
 * The whole feature is three grouped SQL queries and a join back onto a
 * generated list of months. There is nothing here a fake could check: what has
 * to be right is that `date_trunc`-style bucketing agrees with the months the
 * chart draws, that a month with no rows still appears, and that the ratio is
 * computed over the right denominator.
 *
 * The flagged ratio is the one that matters most. `PLAN/12` §11 makes it the
 * metric that decides whether the trust score is doing anything at all, and its
 * 12% threshold is explicitly not calibrated — a series that quietly mislabels a
 * month would make the calibration wrong rather than absent, which is worse.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const suffix = TENANT.slice(0, 8);

/** A fixed "now", so the months under test never depend on the calendar. */
const NOW = new Date('2026-06-15T00:00:00.000Z');

const SCOPE = {
  modules: new Set(['attendance', 'leave']),
  canViewTenant: true,
};

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

async function punch(iso: string, review: 'ACCEPTED' | 'NEEDS_REVIEW'): Promise<void> {
  await owner.punchLog.create({
    data: {
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      type: 'IN',
      source: 'WEB',
      punchedAt: new Date(`${iso}T01:00:00.000Z`),
      workDate: day(iso),
      review,
      trustScore: review === 'ACCEPTED' ? 90 : 40,
      dedupeKey: `trend-${randomUUID()}`,
    },
  });
}

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'trends-test-plan' },
    create: {
      code: 'trends-test-plan',
      name: 'Trends Test',
      modules: { create: [{ moduleCode: 'attendance' }, { moduleCode: 'leave' }] },
    },
    update: {},
  });

  await owner.tenant.create({
    data: {
      id: TENANT,
      code: `t-trend-${suffix}`,
      name: 'Trends Test',
      status: 'ACTIVE',
      planCode: 'trends-test-plan',
    },
  });

  await owner.employee.create({
    data: {
      id: EMPLOYEE,
      tenantId: TENANT,
      employeeNumber: `T1-${suffix}`,
      fullName: 'Trend Probe',
      joinDate: day('2024-01-01'),
    },
  });

  // April: 4 punches, 1 flagged → 25%.
  await punch('2026-04-06', 'NEEDS_REVIEW');
  for (const d of ['2026-04-07', '2026-04-08', '2026-04-09']) await punch(d, 'ACCEPTED');

  // May: deliberately EMPTY, to prove a gap is reported as a gap.

  // June: 2 punches, 2 flagged → 100%.
  await punch('2026-06-01', 'NEEDS_REVIEW');
  await punch('2026-06-02', 'NEEDS_REVIEW');

  await owner.attendanceDay.createMany({
    data: [
      { tenantId: TENANT, employeeId: EMPLOYEE, workDate: day('2026-04-06'), status: 'ABSENT' },
      { tenantId: TENANT, employeeId: EMPLOYEE, workDate: day('2026-04-07'), status: 'LATE' },
      { tenantId: TENANT, employeeId: EMPLOYEE, workDate: day('2026-06-01'), status: 'PRESENT' },
    ],
  });
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
});

const build = async (months = 6) =>
  withTenant(TENANT, (tx) => buildTrends(tx, TENANT, SCOPE, { months, now: NOW }));

describe('the month axis', () => {
  it('returns the requested number of months, oldest first, ending with the current one', async () => {
    const trends = await build(6);

    expect(trends.months).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  /**
   * A month with no rows still appears.
   *
   * Left to a `GROUP BY`, an empty month simply does not come back — and a chart
   * drawn from that joins the month before it to the month after, which reads as
   * continuity where there was a gap. May is empty on purpose.
   */
  it('includes a month with no data at all', async () => {
    const trends = await build(6);
    const may = trends.attendance!.find((p) => p.month === '2026-05');

    expect(may).toBeDefined();
    expect(may!.punches).toBe(0);
  });

  it('clamps an absurd range rather than refusing it', async () => {
    expect((await build(9_999)).months).toHaveLength(MAX_TREND_MONTHS);
    expect((await build(0)).months).toHaveLength(1);
  });
});

describe('the flagged ratio', () => {
  it('is computed over that month’s punches, not the whole range', async () => {
    const trends = await build(6);
    const april = trends.attendance!.find((p) => p.month === '2026-04')!;
    const june = trends.attendance!.find((p) => p.month === '2026-06')!;

    expect(april).toMatchObject({ punches: 4, flagged: 1 });
    expect(april.flaggedRatio).toBeCloseTo(0.25, 5);

    expect(june).toMatchObject({ punches: 2, flagged: 2 });
    expect(june.flaggedRatio).toBe(1);
  });

  /**
   * `null` for an empty month, never zero.
   *
   * Zero is a measurement — "nothing was flagged" — and an absent month is not
   * one. Rendered the same way, a gap in the data becomes a claim about the
   * business, and this metric is the one a tenant would calibrate a threshold
   * against.
   */
  it('is null for a month with no punches, not zero', async () => {
    const trends = await build(6);
    const may = trends.attendance!.find((p) => p.month === '2026-05')!;

    expect(may.flaggedRatio).toBeNull();
    expect(may.flagged).toBe(0);
  });
});

describe('the day statuses', () => {
  it('counts absent, late, and present separately', async () => {
    const trends = await build(6);
    const april = trends.attendance!.find((p) => p.month === '2026-04')!;
    const june = trends.attendance!.find((p) => p.month === '2026-06')!;

    expect(april).toMatchObject({ absentDays: 1, lateDays: 1, presentDays: 0 });
    expect(june).toMatchObject({ absentDays: 0, lateDays: 0, presentDays: 1 });
  });
});

describe('scope', () => {
  /**
   * A trend is a tenant-wide figure by construction, so it needs the tenant-wide
   * permission. The gateway checks it too; this is the second layer, and it is
   * here because a trend is a different question from a summary and could
   * otherwise be reached through a route that only checked the latter.
   */
  it('returns nothing without the tenant permission', async () => {
    const trends = await withTenant(TENANT, (tx) =>
      buildTrends(tx, TENANT, { ...SCOPE, canViewTenant: false }, { months: 6, now: NOW }),
    );

    expect(trends.attendance).toBeNull();
    expect(trends.leave).toBeNull();
    // The month axis is still returned: it discloses nothing and lets a screen
    // render an empty frame rather than nothing at all.
    expect(trends.months).toHaveLength(6);
  });

  /**
   * A module the tenant does not subscribe to yields `null`, not an empty array.
   *
   * The distinction is the same one the summary makes: zero is a number and
   * numbers read as facts. "Flagged punches: 0" for a tenant without attendance
   * is not information, it is a misunderstanding waiting to happen.
   */
  it('returns null for a module the tenant does not have', async () => {
    const trends = await withTenant(TENANT, (tx) =>
      buildTrends(tx, TENANT, { ...SCOPE, modules: new Set(['leave']) }, { months: 6, now: NOW }),
    );

    expect(trends.attendance).toBeNull();
    expect(trends.leave).not.toBeNull();
  });
});
