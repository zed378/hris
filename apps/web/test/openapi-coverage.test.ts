import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST, type RouteId } from '../src/lib/route-manifest.ts';
import { buildOpenApiDocument } from '../src/lib/openapi.ts';

/**
 * OpenAPI coverage (P6-18.1, P6-18.2).
 *
 * The OpenAPI document is generated from `ROUTE_MANIFEST`: paths, methods,
 * permissions, and modules come from there. What cannot be derived is the
 * prose — what an endpoint is for — and that lives in `DOCS` in
 * `src/lib/openapi.ts`.
 *
 * A route with no `DOCS` entry falls back to its route id as the summary. The
 * document then looks complete while saying nothing, and a reader who trusts
 * the document cannot tell a documented endpoint from an undocumented one.
 * This test reads both sources and names every route still undocumented.
 *
 * Written failing on 2026-10-21 with 86 undocumented routes; P6-18.2 documented
 * them on 2026-10-22.
 */

const doc = buildOpenApiDocument({ plane: 'tenant' });
const paths = doc.paths as Record<string, Record<string, { summary?: string }>>;

/** `POST /api/leave/requests/[id]/decision` → method `post`, path `/api/leave/requests/{id}/decision`. */
function splitRouteId(routeId: RouteId): { method: string; path: string } {
    const [method = 'GET', rawPath = '/'] = routeId.split(' ');
    return { method: method.toLowerCase(), path: rawPath.replace(/\[([^\]]+)\]/g, '{$1}') };
}

/** Routes with no `DOCS` entry: their summary falls back to the route id. */
function undocumentedRoutes(): RouteId[] {
    const out: RouteId[] = [];
    for (const routeId of Object.keys(ROUTE_MANIFEST) as RouteId[]) {
        const { method, path } = splitRouteId(routeId);
        const operation = paths[path]?.[method];
        if (!operation || operation.summary === routeId) out.push(routeId);
    }
    return out;
}

describe('OpenAPI coverage', () => {
    it('generates a document covering the manifest', () => {
        // Without this, a broken generator producing an empty document would
        // count every route as undocumented — and a later guard comparing
        // against an empty list would pass while checking nothing.
        const routeIds = Object.keys(ROUTE_MANIFEST) as RouteId[];
        expect(routeIds.length).toBeGreaterThan(50);
        expect(Object.keys(paths).length).toBeGreaterThan(0);
    });

    it('gives every manifest route a path and method', () => {
        const missing: string[] = [];
        for (const routeId of Object.keys(ROUTE_MANIFEST) as RouteId[]) {
            const { method, path } = splitRouteId(routeId);
            if (!paths[path]?.[method]) missing.push(`${routeId} → ${method} ${path}`);
        }

        expect(missing, `routes missing from the document: ${missing.join(', ')}`).toEqual([]);
    });

    it('documents every manifest route', () => {
        const missing = undocumentedRoutes();

        // Named route by route rather than "expected N to equal M", so the
        // failure says what to write.
        expect(
            missing,
            `${missing.length} routes undocumented:\n` + missing.map((id) => `  - ${id}`).join('\n'),
        ).toEqual([]);
    });
});
