import { NextResponse } from 'next/server';
import { buildTrends, MAX_TREND_MONTHS } from '@hrms/core/dashboard';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VIEW_TENANT = 'core.dashboard.view.tenant';

/**
 * Month-over-month trends.
 *
 * Separate from `GET /api/dashboard` on purpose, and the reason is the dashboard
 * itself: the summary is what the screen needs before it can show anything, and
 * these three grouped queries are not. Folding them in would make every load of
 * every dashboard — including one for a user who cannot see tenant figures at
 * all — wait for work most of them will never display.
 *
 * `core.dashboard.view.tenant`, not `.own`. A trend is a tenant-wide figure by
 * construction: there is no per-employee version of "the flagged ratio across
 * the company", and offering one scoped down would answer a question nobody
 * asked with a number that looks like the one they did.
 */
export const GET = defineRoute('GET /api/dashboard/trends', async (req, ctx) => {
  const requested = Number(new URL(req.url).searchParams.get('months') ?? '6');

  // Clamped rather than refused. A silly `months` value is a client bug, and
  // answering it with a sane range shows something useful instead of an error
  // nobody can act on. `buildTrends` clamps as well — this is not redundant,
  // it is the layer that decides what a NaN means.
  const months = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_TREND_MONTHS)
    : 6;

  const trends = await buildTrends(
    ctx.tx,
    ctx.tenantId,
    {
      modules: new Set(ctx.access.modules),
      canViewTenant: ctx.access.permissions.includes(VIEW_TENANT),
    },
    { months },
  );

  return NextResponse.json(trends);
});
