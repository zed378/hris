import { renderMetrics, metricsEnabled, metricsTokenMatches } from '@hrms/observability';
import { definePublicRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Prometheus metrics (PLAN/14 §9.3).
 *
 * **Disabled unless `METRICS_TOKEN` is set**, and 404 when it is not. `PLAN/13`
 * recorded "no metrics yet — added when someone actually collects them", and
 * that restraint was right: an endpoint nobody scrapes is a maintenance burden
 * wearing the costume of observability. A deployment that collects nothing gets
 * exactly what it had before.
 *
 * ## What is here, and what must never be
 *
 * Request counts, durations, and statuses, labelled by route. **No tenant
 * identifier appears anywhere**, and that is a security rule rather than a
 * design preference: this is read by infrastructure and stored in a time-series
 * database that outlives every access control in this system. A `tenant_id`
 * label publishes the customer list. A per-tenant flagged ratio publishes their
 * business.
 *
 * `PLAN/12` §11 lists ten metrics worth watching and several are exactly that
 * kind. They belong on the dashboard, behind a permission — and they are there.
 *
 * ## Why a 404 rather than a 401
 *
 * An unconfigured endpoint should be indistinguishable from an absent one. A 401
 * confirms there is something here to find a token for, which is the only thing
 * a scanner wanted to learn.
 */
export const GET = definePublicRoute('GET /api/metrics', async (req) => {
  const notFound = new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

  if (!metricsEnabled()) return notFound;

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!metricsTokenMatches(presented)) return notFound;

  return new Response(renderMetrics(), {
    status: 200,
    headers: {
      // The version suffix is what makes Prometheus parse it rather than guess.
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
});
