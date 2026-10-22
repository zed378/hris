import { describe, expect, it } from 'vitest';
import config from '../next.config';

/**
 * P6-12 — browser security headers (risk F5).
 *
 * Loads the REAL next.config.ts rather than a copy of its header values: a
 * copy would pass while the config silently lost a header. The assertions
 * are on header strings present in the config, not on a running Next server,
 * so the suite stays hermetic — no production-only HTTPS behaviour is
 * asserted (HSTS is ignored by browsers over plain HTTP by design).
 */

interface HeaderRule {
    source: string;
    headers: { key: string; value: string }[];
}

async function headerRules(): Promise<HeaderRule[]> {
    expect(typeof config.headers).toBe('function');
    return config.headers!();
}

describe('security headers (P6-12)', () => {
    it('applies headers to every path', async () => {
        const rules = await headerRules();
        expect(rules).toHaveLength(1);
        expect(rules[0]!.source).toBe('/:path*');
    });

    it.each([
        ['Content-Security-Policy'],
        ['X-Content-Type-Options'],
        ['X-Frame-Options'],
        ['Referrer-Policy'],
        ['Strict-Transport-Security'],
    ])('sets %s', async (key) => {
        const rules = await headerRules();
        const set = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));
        expect(set.get(key)).toBeTruthy();
    });

    it('uses the required values', async () => {
        const rules = await headerRules();
        const set = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));

        expect(set.get('X-Content-Type-Options')).toBe('nosniff');
        expect(set.get('X-Frame-Options')).toBe('DENY');
        expect(set.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
        // Safe value: one year, subdomains included, no preload — a first HTTPS
        // deployment cannot be locked out by a shorter hard-coded preload list.
        expect(set.get('Strict-Transport-Security')).toBe(
            'max-age=31536000; includeSubDomains',
        );

        const csp = set.get('Content-Security-Policy')!;
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain("form-action 'self'");
        expect(csp).toContain("object-src 'none'");
    });

    // Found reviewing P6-12: each of these broke or weakened something real.
    it('allows the punch photo preview (a blob: URL)', async () => {
        const csp = (await headerRules())[0]!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
        expect(csp).toMatch(/img-src [^;]*blob:/);
    });

    it('allows eval only under next dev, never in a build', async () => {
        // Vitest runs with NODE_ENV=test — a stand-in for "not development".
        const csp = (await headerRules())[0]!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
        expect(csp).not.toContain("'unsafe-eval'");
    });

    it('trusts no other origin and does not rewrite plain-HTTP assets', async () => {
        const csp = (await headerRules())[0]!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
        expect(csp).not.toContain('https:');
        expect(csp).not.toContain('upgrade-insecure-requests');
    });
});
