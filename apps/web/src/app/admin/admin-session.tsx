'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Sesi bidang admin — **terpisah total** dari sesi tenant (P11).
 *
 * Tidak memakai `useSession` dari `@/lib/session.tsx`, tidak berbagi cookie,
 * tidak berbagi penyimpanan. Pemisahan itu adalah keseluruhan gunanya: satu
 * berkas yang mengimpor keduanya adalah satu berkas yang dapat keliru memakai
 * token tenant untuk memanggil control plane, dan pada saat itu setiap pelanggan
 * memegang kunci ke metadata seluruh pelanggan lain.
 *
 * ## Mengapa token hanya di memori, dan mengapa tidak ada refresh
 *
 * Token superuser hidup 8 jam dan **hanya di memori React** — tidak di
 * `localStorage`, tidak di cookie. Konsekuensinya disengaja: menyegarkan halaman
 * berarti masuk lagi, lengkap dengan TOTP.
 *
 * Itu terdengar seperti ketidaknyamanan, dan memang. Tetapi bidang ini memegang
 * metadata seluruh pelanggan, jumlah akunnya dapat dihitung dengan jari, dan
 * dipakai beberapa kali sebulan. Menukar kenyamanan sesi panjang dengan
 * permukaan serangan XSS yang bertahan lintas muat halaman adalah pertukaran
 * yang salah arah di sini — berbeda dari bidang tenant, yang dipakai ratusan
 * orang setiap hari dan karenanya memang punya cookie refresh httpOnly.
 */

interface AdminSession {
  token: string | null;
  email: string | null;
  masuk: (token: string, email: string) => void;
  keluar: () => void;
  /** Fetch yang membawa token superuser. Menolak bila belum masuk. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

const Context = createContext<AdminSession | null>(null);

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const masuk = useCallback((nextToken: string, nextEmail: string) => {
    setToken(nextToken);
    setEmail(nextEmail);
  }, []);

  const keluar = useCallback(() => {
    setToken(null);
    setEmail(null);
  }, []);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      if (!token) throw new Error('Belum masuk');

      const response = await fetch(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
        },
      });

      // Token kedaluwarsa memulangkan ke layar masuk, bukan meninggalkan layar
      // yang diam. Delapan jam habis di tengah pekerjaan adalah kejadian biasa
      // di sini, dan yang mengalaminya perlu tahu apa yang harus dilakukannya.
      if (response.status === 401) keluar();

      return response;
    },
    [token, keluar],
  );

  const value = useMemo<AdminSession>(
    () => ({ token, email, masuk, keluar, api }),
    [token, email, masuk, keluar, api],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAdminSession(): AdminSession {
  const context = useContext(Context);
  if (!context) throw new Error('useAdminSession dipakai di luar AdminSessionProvider');
  return context;
}
