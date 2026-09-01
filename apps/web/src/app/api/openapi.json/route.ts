import { NextResponse } from 'next/server';
import { buildOpenApiDocument } from '@/lib/openapi.ts';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The OpenAPI document for the tenant plane.
 *
 * Behind `core.settings.manage` — an administrator's permission, not an
 * employee's. An API specification is a complete map of the system: every path,
 * every parameter, every guard. Publishing it to whoever asks hands that map to
 * anyone scanning, and this product has no public API yet for which the trade
 * would be worth making (PLAN/14 §13.1).
 *
 * The consequence to accept: a developer integrating against this API needs an
 * administrator account to read its documentation. That is the correct default
 * for a private API, and the day a public one exists is the day to publish a
 * SEPARATE document describing only the endpoints meant for it.
 *
 * Generated on every request rather than cached. It is built from an object
 * literal and a handful of Zod schemas — microseconds — and a cache would only
 * introduce the possibility of serving a document that no longer matches the
 * routes.
 */
export const GET = defineRoute('GET /api/openapi.json', async () => {
  return NextResponse.json(buildOpenApiDocument({ plane: 'tenant' }), {
    headers: { 'cache-control': 'no-store' },
  });
});
