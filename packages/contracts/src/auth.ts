import { z } from 'zod';

/**
 * Kode tenant dipakai bersama email saat login (PLAN/06 §3.3).
 *
 * Alasan tidak memakai email saja: satu orang dapat menjadi pengguna di lebih
 * dari satu tenant (konsultan HR, grup perusahaan). Tanpa kode tenant, sistem
 * harus menebak — atau menampilkan daftar tenant yang memuat email itu, yang
 * dengan sendirinya membocorkan informasi kepada penebak kata sandi.
 */
export const tenantCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 'Kode tenant tidak sah');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Panjang minimum 12, tanpa aturan komposisi.
 *
 * Aturan "wajib satu huruf besar dan satu simbol" menghasilkan `Password1!` —
 * panjang adalah satu-satunya syarat yang benar-benar berkorelasi dengan
 * ketahanan. Batas atas 128 mencegah DoS lewat argon2 pada masukan raksasa.
 */
export const passwordSchema = z.string().min(12, 'Kata sandi minimal 12 karakter').max(128);

export const loginRequestSchema = z.object({
  tenantCode: tenantCodeSchema,
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/**
 * Klaim token akses.
 *
 * `aud` memisahkan dua bidang: token tenant (`hrms-tenant`) ditolak
 * `admin-gateway`, dan token superuser (`hrms-admin`) ditolak gateway tenant.
 * Superuser bukan pengguna dengan izin lebih banyak — ia entitas di bidang
 * berbeda (P11, PLAN/07 §3).
 */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  tenantCode: tenantCodeSchema,
  email: emailSchema,
  /** Versi akses efektif; dipakai membatalkan cache permission seketika. */
  av: z.number().int().nonnegative(),
  aud: z.literal('hrms-tenant'),
  iss: z.literal('hrms'),
  exp: z.number().int(),
  iat: z.number().int(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
