import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@hrms/contracts';

const ISSUER = 'hrms';
export const TENANT_AUDIENCE = 'hrms-tenant';
/** Audience control plane. Sengaja tidak pernah diterima gateway tenant (P11). */
export const ADMIN_AUDIENCE = 'hrms-admin';

function secret(): Uint8Array {
  const value = process.env['JWT_SECRET'];
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET belum dipasang atau kurang dari 32 karakter.');
  }
  return new TextEncoder().encode(value);
}

function accessTtlSeconds(): number {
  return Number(process.env['ACCESS_TOKEN_TTL_SECONDS'] ?? 900);
}

export function refreshTtlDays(): number {
  return Number(process.env['REFRESH_TOKEN_TTL_DAYS'] ?? 30);
}

export interface AccessTokenInput {
  userId: string;
  tenantId: string;
  tenantCode: string;
  email: string;
  accessVersion: number;
}

/**
 * Token akses berumur 15 menit.
 *
 * Umur pendek adalah yang membuat pencabutan bekerja tanpa daftar-cabut
 * terpusat: seorang pengguna yang aksesnya dicabut kehilangan akses paling lama
 * satu TTL kemudian, tanpa gateway perlu memeriksa basis data pada tiap request.
 *
 * `av` (versi akses) mempersempitnya lebih jauh untuk perubahan permission —
 * gateway membandingkan versi di token dengan yang tercatat dan menolak yang basi.
 */
export async function issueAccessToken(input: AccessTokenInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: input.tenantId,
    tenantCode: input.tenantCode,
    email: input.email,
    av: input.accessVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(TENANT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + accessTtlSeconds())
    .sign(secret());
}

export class TokenVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: 'expired' | 'invalid',
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

/**
 * Memverifikasi token akses tenant.
 *
 * `audience` diperiksa secara eksplisit. Inilah yang menegakkan pemisahan dua
 * bidang: token superuser (`hrms-admin`) gagal di sini, sehingga kredensial
 * control plane tidak pernah dapat dipakai pada endpoint data tenant.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: TENANT_AUDIENCE,
      algorithms: ['HS256'],
    });
    return accessTokenClaimsSchema.parse(payload);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new TokenVerificationError('Token akses kedaluwarsa', 'expired');
    }
    throw new TokenVerificationError('Token akses tidak sah', 'invalid');
  }
}

/**
 * Refresh token adalah nilai acak, bukan JWT.
 *
 * Alasannya: refresh token harus dapat dicabut seketika, dan itu menuntut
 * pencarian ke basis data pada setiap pemakaian. Bila pencarian tetap diperlukan,
 * menandatanganinya sebagai JWT tidak menambah apa pun selain ukuran.
 *
 * Yang disimpan adalah SHA-256-nya. Basis data yang bocor tidak memberi penyerang
 * satu pun sesi yang dapat dipakai.
 */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(48).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function accessTokenTtlSeconds(): number {
  return accessTtlSeconds();
}
