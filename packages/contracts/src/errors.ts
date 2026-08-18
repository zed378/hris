/**
 * Kode galat API.
 *
 * Stabil dan dapat dibaca mesin. Frontend bercabang pada kode ini, bukan pada
 * teks pesan — pesan boleh berubah dan diterjemahkan, kode tidak.
 */
export const ErrorCode = {
  /** Kredensial salah. Sengaja tidak membedakan email vs kata sandi vs tenant. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** Refresh token yang sudah digantikan dipakai lagi — indikasi pencurian. */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',

  /** Header X-Tenant-ID tidak cocok dengan klaim token. */
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',

  /** Peran mengizinkan, tetapi tenant tidak melanggan modulnya (P8). HTTP 402. */
  MODULE_NOT_SUBSCRIBED: 'MODULE_NOT_SUBSCRIBED',
  /** Modul dilanggan, tetapi pengguna tidak memegang permission-nya. HTTP 403. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** Galat validasi per field. */
    details?: Record<string, string[]>;
    correlationId?: string;
  };
}
