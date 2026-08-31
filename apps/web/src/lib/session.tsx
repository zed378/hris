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
 * Sesi di sisi klien.
 *
 * Access token hidup **hanya di memori** — tidak di `localStorage`, tidak di
 * Cache Storage, tidak di IndexedDB (PLAN/11 §5.3). Konsekuensinya nyata: muat
 * ulang halaman menghilangkannya. Itu bukan cacat, melainkan alasan adanya
 * refresh token sebagai cookie httpOnly — saat aplikasi dimuat, ia menukar
 * cookie itu dengan access token baru, dan JavaScript tidak pernah menyentuh
 * kredensial yang bertahan.
 *
 * Yang disimpan di sini menentukan apa yang bocor ketika ada XSS. Dengan pola
 * ini, yang dapat dicuri hanyalah token berumur 15 menit.
 */

interface SessionState {
  status: 'loading' | 'authenticated' | 'anonymous';
  bootstrap: BootstrapResponse | null;
  /** Fetch ke API dengan Authorization terisi dan penyegaran token otomatis. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  login: (input: { tenantCode: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  hasModule: (moduleCode: string) => boolean;
  /**
   * Memuat ulang izin, modul, dan menu tanpa login ulang.
   *
   * Dibutuhkan ketika langganan berubah dari dalam aplikasi: DoD Fase 6
   * menuntut perubahan tercermin di UI dalam sepuluh detik, dan meminta orang
   * keluar-masuk kembali setelah mengaktifkan modul adalah kegagalan yang
   * paling terasa justru pada langkah yang paling ingin dibuat mulus.
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

  /** Menukar cookie refresh dengan access token baru. */
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
   * Pembungkus fetch dengan satu percobaan ulang setelah menyegarkan token.
   *
   * Satu percobaan, bukan berulang. Bila penyegaran berhasil tetapi request
   * tetap 401, masalahnya bukan token kedaluwarsa — dan mencoba lagi hanya
   * mengubah kegagalan yang jelas menjadi lingkaran yang membingungkan.
   */
  const api = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      // `content-type` TIDAK dipasang untuk FormData.
      //
      // Unggahan multipart membawa boundary yang dibangkitkan browser, dan
      // boundary itu hanya ada bila header dibiarkan kosong. Memasang
      // "application/json" pada FormData membuat server menerima badan yang
      // tidak dapat diurai — dan galatnya muncul sebagai "berkas tidak
      // ditemukan", bukan sebagai masalah content-type.
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

  // Saat aplikasi dimuat: coba tukar cookie menjadi sesi. Gagal berarti anonim,
  // bukan galat — pengguna yang belum pernah masuk juga melewati jalur ini.
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
     * Langganan push dicabut SEBELUM sesinya dibuang.
     *
     * Pencabutan memanggil endpoint yang menuntut token, dan token itu hilang
     * satu baris di bawah. Urutan sebaliknya meninggalkan langganan yang tetap
     * hidup di server: perangkat bersama akan terus menerima notifikasi milik
     * pengguna sebelumnya — nama, tanggal cuti, dan keputusannya di layar
     * terkunci orang lain — dan tidak ada galat yang muncul di mana pun.
     */
    await unsubscribeFromPush(api);

    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    accessToken.current = null;
    setBootstrap(null);
    setStatus('anonymous');

    // Cache service worker dibersihkan total (dokumen 11 §5.2, risiko R50).
    //
    // Cache Storage bertahan setelah logout dan dapat dibaca skrip mana pun di
    // origin yang sama. Di perangkat bersama — ruang HR, pos satpam, komputer
    // pabrik — itu berarti data pengguna sebelumnya terbaca pengguna berikutnya.
    //
    // Antrean presensi luring SENGAJA tidak ikut dihapus: ia milik perangkat,
    // bukan milik sesi, dan menghapusnya berarti membuang presensi yang belum
    // sempat terkirim milik orang yang baru saja keluar.
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
      // Ini kenyamanan tampilan, bukan otorisasi. Setiap kontrol yang disembunyikan
      // di sini punya pasangannya di ROUTE_MANIFEST, dan bila keduanya berbeda,
      // gateway yang benar (P9).
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
