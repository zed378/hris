'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { BootstrapResponse } from '@hrms/contracts';
import { unsubscribeFromPush } from './push.ts';

/**
 * The client-side session.
 *
 * The access token lives **in memory only** — not in `localStorage`, not in
 * Cache Storage, not in IndexedDB (PLAN/11 §5.3). The consequence is real:
 * reloading the page discards it. That is not a flaw but the reason the refresh
 * token exists as an httpOnly cookie — when the app loads it exchanges that
 * cookie for a fresh access token, and JavaScript never touches a credential
 * that persists.
 *
 * What is stored here decides what leaks when there is an XSS. With this
 * pattern, all that can be stolen is a token that expires in 15 minutes.
 */

interface SessionState {
  status: 'loading' | 'authenticated' | 'anonymous';
  bootstrap: BootstrapResponse | null;
  /** A fetch to the API with Authorization filled in and automatic token refresh. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  login: (input: { tenantCode: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  hasModule: (moduleCode: string) => boolean;
  /**
   * Reloads permissions, modules, and menus without a fresh login.
   *
   * Needed when a subscription changes from inside the application: the Phase 6
   * DoD demands the change be reflected in the UI within ten seconds, and asking
   * someone to log out and back in after enabling a module is a failure felt
   * most on the step one most wants to feel smooth.
   */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  return new ApiError(
    response.status,
    body?.error?.code ?? 'UNKNOWN',
    body?.error?.message ?? 'Terjadi kesalahan',
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const accessToken = useRef<string | null>(null);
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);

  /** Exchanges the refresh cookie for a fresh access token. */
  const renew = useCallback(async (): Promise<boolean> => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      accessToken.current = null;
      return false;
    }
    const body = (await response.json()) as { accessToken: string };
    accessToken.current = body.accessToken;
    return true;
  }, []);

  const loadBootstrap = useCallback(async (): Promise<boolean> => {
    const response = await fetch('/api/me/bootstrap', {
      credentials: 'same-origin',
      headers: accessToken.current ? { authorization: `Bearer ${accessToken.current}` } : {},
    });
    if (!response.ok) return false;
    setBootstrap((await response.json()) as BootstrapResponse);
    return true;
  }, []);

  /**
   * A fetch wrapper with one retry after refreshing the token.
   *
   * One retry, not repeated ones. If the refresh succeeds and the request is
   * still 401, the problem is not an expired token — and retrying only turns a
   * clear failure into a confusing loop.
   */
  const api = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      // `content-type` is NOT set for FormData.
      //
      // A multipart upload carries a browser-generated boundary, and that
      // boundary only exists when the header is left empty. Setting
      // "application/json" on FormData makes the server receive a body it cannot
      // parse — and its error appears as "file not found" rather than as a
      // content-type problem.
      const isJsonBody = init.body !== undefined && !(init.body instanceof FormData);

      const call = (): Promise<Response> =>
        fetch(path, {
          ...init,
          credentials: 'same-origin',
          headers: {
            ...(init.headers ?? {}),
            ...(accessToken.current ? { authorization: `Bearer ${accessToken.current}` } : {}),
            ...(isJsonBody ? { 'content-type': 'application/json' } : {}),
          },
        });

      let response = await call();
      if (response.status === 401 && (await renew())) {
        response = await call();
      }
      if (response.status === 401) {
        setStatus('anonymous');
        setBootstrap(null);
      }
      return response;
    },
    [renew],
  );

  // On application load: try exchanging the cookie for a session. A failure means
  // anonymous, not an error — a user who has never logged in takes this path too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = (await renew()) && (await loadBootstrap());
      if (!cancelled) setStatus(ok ? 'authenticated' : 'anonymous');
    })();
    return () => {
      cancelled = true;
    };
  }, [renew, loadBootstrap]);

  const login = useCallback<SessionState['login']>(
    async (input) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw await readError(response);

      const body = (await response.json()) as { accessToken: string };
      accessToken.current = body.accessToken;
      await loadBootstrap();
      setStatus('authenticated');
    },
    [loadBootstrap],
  );

  const logout = useCallback(async () => {
    /**
     * The push subscription is unsubscribed BEFORE the session is discarded.
     *
     * Unsubscribing calls an endpoint that demands a token, and that token
     * disappears one line below. The reverse order leaves a subscription alive on
     * the server: a shared device would keep receiving the previous user's
     * notifications — their name, leave dates, and the decision on someone
     * else's lock screen — with no error appearing anywhere.
     */
    await unsubscribeFromPush(api);

    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    accessToken.current = null;
    setBootstrap(null);
    setStatus('anonymous');

    // The service worker cache is wiped completely (document 11 §5.2, risk R50).
    //
    // Cache Storage survives a logout and can be read by any script on the same
    // origin. On a shared device — an HR room, a security post, a factory
    // computer — that means the previous user's data is readable by the next.
    //
    // The offline punch queue is DELIBERATELY not cleared: it belongs to the
    // device, not to the session, and clearing it would throw away the unsent
    // punches of whoever just logged out.
    navigator.serviceWorker?.controller?.postMessage({ type: 'HRMS_LOGOUT' });
  }, [api]);

  const value = useMemo<SessionState>(() => {
    const permissions = new Set(bootstrap?.permissions ?? []);
    const modules = new Set(bootstrap?.modules ?? []);
    return {
      status,
      bootstrap,
      api,
      login,
      logout,
      // This is display convenience, not authorisation. Every control hidden here
      // has its counterpart in ROUTE_MANIFEST, and where the two differ, the
      // gateway is right (P9).
      can: (permission) => permissions.has(permission),
      hasModule: (moduleCode) => modules.has(moduleCode),
      refresh: async () => {
        await loadBootstrap();
      },
    };
  }, [status, bootstrap, api, login, logout, loadBootstrap]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession harus dipakai di dalam <SessionProvider>');
  return context;
}
