import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the trusted-proxy client-address resolution (P3-12).
 *
 * Every row of the spec's abuse-case table (§14) that can be decided without a
 * running proxy is here. The integration rows — a spoofed header through the
 * real punch handler — live with the gateway tests; this file pins the
 * decision function itself, because a regression here is invisible: nothing
 * raises, nothing logs per request, the office match just quietly stops
 * being trustworthy.
 */

const ORIGINAL_TRUST_PROXY = process.env['TRUST_PROXY'];

function setTrustProxy(value: string | undefined): void {
    process.env['TRUST_PROXY'] = value;
    // The module reads the env once at load; re-import a fresh copy per scenario.
    vi.resetModules();
}

afterEach(() => {
    process.env['TRUST_PROXY'] = ORIGINAL_TRUST_PROXY;
    vi.resetModules();
});

async function load() {
    return await import('../src/client-address.ts');
}

describe('clientAddress — TRUST_PROXY=false (default topology)', () => {
    it('ignores every forwarding header, including a spoofed office address', async () => {
        setTrustProxy('false');
        const { clientAddress } = await load();

        const headers = new Headers({
            'x-forwarded-for': '203.0.113.10',
            'x-real-ip': '198.51.100.1',
        });
        expect(clientAddress(headers)).toBeUndefined();
    });

    it('ignores the headers when the variable is unset entirely', async () => {
        setTrustProxy(undefined);
        const { clientAddress } = await load();

        const headers = new Headers({ 'x-real-ip': '198.51.100.1' });
        expect(clientAddress(headers)).toBeUndefined();
    });

    it('reports the mode as untrusted', async () => {
        setTrustProxy('false');
        const { clientAddressMode } = await load();
        expect(clientAddressMode()).toBe('untrusted');
    });
});

describe('clientAddress — TRUST_PROXY=true (split topology behind nginx)', () => {
    it('reads only X-Real-IP, the value the proxy observed', async () => {
        setTrustProxy('true');
        const { clientAddress } = await load();

        // The client-supplied XFF is present and ignored — the exact §4(a) attack.
        const headers = new Headers({
            'x-forwarded-for': '203.0.113.10, 198.51.100.1',
            'x-real-ip': '198.51.100.1',
        });
        expect(clientAddress(headers)).toBe('198.51.100.1');
    });

    it('returns undefined when X-Real-IP is absent, and warns once', async () => {
        setTrustProxy('true');
        const { clientAddress } = await load();

        const warn = vi.spyOn(console, 'error').mockImplementation(() => { });
        expect(clientAddress(new Headers())).toBeUndefined();
        expect(clientAddress(new Headers())).toBeUndefined();
        // One warn per process, not per request.
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('rejects a multi-valued X-Real-IP as malformed', async () => {
        setTrustProxy('true');
        const { clientAddress } = await load();

        expect(clientAddress(new Headers({ 'x-real-ip': '198.51.100.1, 203.0.113.9' }))).toBeUndefined();
    });

    it('reports the mode as trusted-proxy', async () => {
        setTrustProxy('true');
        const { clientAddressMode } = await load();
        expect(clientAddressMode()).toBe('trusted-proxy');
    });
});

describe('forwardedClientAddress — the web → auth handoff', () => {
    it('accepts the forwarded address when the internal secret is valid', async () => {
        const { forwardedClientAddress } = await load();

        const headers = new Headers({ 'x-forwarded-client-ip': '198.51.100.7' });
        expect(forwardedClientAddress(headers, true)).toBe('198.51.100.7');
    });

    it('ignores the header without the internal secret — the §10 abuse case', async () => {
        const { forwardedClientAddress } = await load();

        // A client that learned the header name and sends it directly to the auth
        // service gets nothing: the address falls back to local resolution.
        const headers = new Headers({ 'x-forwarded-client-ip': '203.0.113.10' });
        expect(forwardedClientAddress(headers, false)).toBeUndefined();
    });

    it('rejects a multi-valued forwarded address', async () => {
        const { forwardedClientAddress } = await load();

        const headers = new Headers({ 'x-forwarded-client-ip': '198.51.100.7, 203.0.113.10' });
        expect(forwardedClientAddress(headers, true)).toBeUndefined();
    });
});
