import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The service worker caching policy (Phase 3 DoD).
 *
 * Its DoD item reads: "Dashboard and sensitive-data endpoints never enter Cache
 * Storage — verified by an automated test."
 *
 * This test runs the ACTUAL `public/sw.js` inside a VM context with faked
 * service worker globals. Copying its logic into the test file would test the
 * copy rather than what ships — and that copy would differ from the original at
 * the first change somebody forgets to copy.
 *
 * What is guarded is not tidiness. Cache Storage survives a tab closing,
 * survives a logout, and can be read by any script running on the same origin.
 * One API response stored there is personnel data left behind on a shared
 * device — a warehouse phone passed between three shifts, a receptionist's
 * computer, a tablet in a meeting room.
 */

const SW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/sw.js',
);

interface FetchEvent {
  request: Request;
  respondWith: (response: unknown) => void;
}

type FetchHandler = (event: FetchEvent) => void;

/** Loads the real sw.js and returns its `fetch` handler. */
function loadServiceWorker(): { onFetch: FetchHandler; cachePuts: string[] } {
  const source = readFileSync(SW_PATH, 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();

  // Every `cache.put` is recorded. That is what proves something genuinely
  // entered Cache Storage — not merely that the handler did not throw.
  const cachePuts: string[] = [];

  const fakeCache = {
    put: (request: Request | string, _response: unknown) => {
      cachePuts.push(typeof request === 'string' ? request : request.url);
      return Promise.resolve();
    },
    add: () => Promise.resolve(),
    match: () => Promise.resolve(undefined),
  };

  const sandbox = {
    self: {
      location: new URL('https://hrms.test/'),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
      registration: { pushManager: { getSubscription: () => Promise.resolve(null) } },
    },
    caches: {
      open: () => Promise.resolve(fakeCache),
      match: () => Promise.resolve(undefined),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: () => Promise.resolve(new Response('ok')),
    Response,
    Request,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  };

  runInNewContext(source, sandbox);

  const onFetch = listeners.get('fetch');
  if (!onFetch) throw new Error('sw.js tidak mendaftarkan handler fetch');

  return { onFetch: onFetch as FetchHandler, cachePuts };
}

/**
 * Runs the handler for one request.
 *
 * `intercepted` becomes true when the service worker takes the request over. A
 * request that is NOT taken over is passed through by the browser as it is — and
 * that is what the sensitive paths demand: not "carefully cached", but not
 * touched at all.
 */
function dispatch(
  onFetch: FetchHandler,
  url: string,
  init: { mode?: RequestMode; headers?: Record<string, string>; method?: string } = {},
): { intercepted: boolean } {
  let intercepted = false;

  const request = new Request(url, {
    method: init.method ?? 'GET',
    ...(init.headers ? { headers: init.headers } : {}),
  });
  // `mode` is read-only on a Request, so it is set on top of it.
  Object.defineProperty(request, 'mode', { value: init.mode ?? 'no-cors' });

  onFetch({
    request,
    respondWith: () => {
      intercepted = true;
    },
  });

  return { intercepted };
}

describe('service worker tidak menyentuh jalur sensitif', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('melewatkan seluruh endpoint API', () => {
    // Including the ones that do not exist yet. A guard based on the `/api/`
    // prefix closes endpoints added in a later phase without anyone needing to
    // remember to update a list.
    //
    // Some are tested with `mode: 'navigate'`, and that is deliberate. A `cors`
    // request is never taken over by this handler — so testing the API with
    // `cors` alone would PASS even with the `NEVER_CACHE` guard removed
    // entirely. A test that passes for the wrong reason guards nothing.
    //
    // A `navigate` to an API path is not an invented scenario: opening an export
    // URL directly in a new tab produces exactly that request.
    for (const path of [
      '/api/dashboard',
      '/api/employees',
      '/api/payroll/payslips',
      '/api/attendance/records',
      '/api/tenant/export',
      '/api/modul-yang-belum-ada',
    ]) {
      for (const mode of ['cors', 'navigate'] as const) {
        const { intercepted } = dispatch(sw.onFetch, `https://hrms.test${path}`, { mode });
        expect(intercepted, `${path} (${mode}) tidak boleh disentuh service worker`).toBe(
          false,
        );
      }
    }
  });

  it('melewatkan bidang admin sepenuhnya', () => {
    // The admin plane is not a PWA (document 11). One of its pages cached on a
    // device means the control plane interface left behind there.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/admin/tenants', {
      mode: 'navigate',
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan halaman yang memuat kredensial', () => {
    for (const path of ['/login', '/reset-password', '/accept-invitation']) {
      const { intercepted } = dispatch(sw.onFetch, `https://hrms.test${path}`, {
        mode: 'navigate',
      });
      expect(intercepted, `${path} tidak boleh di-cache`).toBe(false);
    }
  });

  it('melewatkan permintaan yang membawa Authorization, apa pun jalurnya', () => {
    // The second guard, and the most important: it closes the paths that DO NOT
    // EXIST yet. A data page added later will not be cached automatically merely
    // because nobody remembered to update the NEVER_CACHE list.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/laporan-baru', {
      mode: 'navigate',
      headers: { authorization: 'Bearer eyJ...' },
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan metode selain GET', () => {
    // A cached POST would replay an action rather than display data.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/api/attendance/punch', {
      method: 'POST',
    });
    expect(intercepted).toBe(false);
  });

  it('melewatkan origin lain', () => {
    const { intercepted } = dispatch(sw.onFetch, 'https://pihak-ketiga.test/skrip.js', {
      mode: 'cors',
    });
    expect(intercepted).toBe(false);
  });
});

describe('service worker menangani yang memang boleh', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('mengambil alih navigasi halaman aplikasi', () => {
    // This is what the PWA is for: the attendance page stays open when the network drops.
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/attendance/punch', {
      mode: 'navigate',
    });
    expect(intercepted).toBe(true);
  });

  it('mengambil alih aset statis berversi', () => {
    const { intercepted } = dispatch(sw.onFetch, 'https://hrms.test/_next/static/chunk-abc.js', {
      mode: 'no-cors',
    });
    expect(intercepted).toBe(true);
  });

  it('tidak menyimpan apa pun ke cache saat menangani navigasi', () => {
    // Navigation uses network-first and only READS the cache as a fallback.
    // Writing to it would leave yesterday's data page on the device.
    dispatch(sw.onFetch, 'https://hrms.test/employees', { mode: 'navigate' });
    expect(sw.cachePuts).toEqual([]);
  });
});

describe('daftar aset kerangka', () => {
  it('tidak memuat satu pun jalur data', () => {
    // `SHELL_ASSETS` is cached at install time, without passing through the fetch
    // handler — so the guards above do not apply to it. One data path on that
    // list would be cached before anything had a chance to refuse it.
    const source = readFileSync(SW_PATH, 'utf8');
    const match = /const SHELL_ASSETS = \[([^\]]*)\]/.exec(source);
    expect(match, 'SHELL_ASSETS tidak ditemukan di sw.js').not.toBeNull();

    const assets = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);

    for (const asset of assets) {
      expect(asset.startsWith('/api/'), `${asset} adalah jalur API`).toBe(false);
      expect(asset.startsWith('/admin/'), `${asset} adalah jalur admin`).toBe(false);
      expect(asset.startsWith('/login'), `${asset} memuat kredensial`).toBe(false);
    }
  });
});
