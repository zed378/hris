import { createHash, randomBytes } from 'node:crypto';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@hrms/contracts';
import { signJwt, verifyJwt, JwtVerificationError } from './jwt.ts';

export const TENANT_AUDIENCE = 'hrms-tenant';
/** Audience control plane. Sengaja tidak pernah diterima gateway tenant (P11). */
export const ADMIN_AUDIENCE = 'hrms-admin';

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
  return signJwt(
    {
      tid: input.tenantId,
      tenantCode: input.tenantCode,
      email: input.email,
      av: input.accessVersion,
    },
    {
      subject: input.userId,
      audience: TENANT_AUDIENCE,
      ttlSeconds: accessTtlSeconds(),
    },
  );
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
    return accessTokenClaimsSchema.parse(await verifyJwt(token, TENANT_AUDIENCE));
  } catch (error) {
    // `expired` and `invalid` are different answers to the client: one refreshes,
    // the other logs out. A schema failure is `invalid` — the signature held but
    // the claims are not what this system issues, which is a token from
    // somewhere else rather than an expired one from here.
    if (error instanceof JwtVerificationError && error.reason === 'expired') {
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
