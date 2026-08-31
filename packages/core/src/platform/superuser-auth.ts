import { generateSecret, generateURI, verifySync } from 'otplib';
import { platformClient } from '@hrms/db';
import { verifyPassword, signJwt, verifyJwt } from '../auth/index.ts';

/**
 * Autentikasi superuser — control plane.
 *
 * Superuser adalah entitas di bidang yang berbeda, bukan pengguna dengan izin
 * lebih banyak (P11, PLAN/07 §3). Konsekuensi yang mengikat seluruh berkas ini:
 *
 *   - Token superuser memakai audience `hrms-admin`. Gateway tenant menolaknya,
 *     dan gateway admin menolak token tenant. Diperiksa uji CI ke dua arah.
 *   - Tidak ada satu pun jalur di sini yang membaca data tenant. Bahkan bila
 *     seseorang menambahkannya, role basis data `hrms_app` tidak memiliki
 *     `USAGE` pada schema `platform` dan sebaliknya — pemisahannya ditegakkan
 *     hak akses, bukan disiplin.
 *   - MFA wajib. Bukan opsi konfigurasi: constraint basis data menolak baris
 *     superuser aktif tanpa `totp_secret`.
 *
 * Yang **tidak** ada di sini, dan itu disengaja: tidak ada cara bagi superuser
 * untuk membaca data tenant mana pun. Akses dukungan hanya lewat support session
 * yang disetujui tenant, melalui gateway yang sama dengan pengguna biasa
 * (PLAN/07 §6). Itu belum dibangun, dan sampai ia dibangun jawabannya adalah
 * "tidak bisa" — bukan pintu belakang sementara.
 */

export const ADMIN_AUDIENCE = 'hrms-admin';
/** Sesi 8 jam, jauh lebih pendek dari sesi tenant. */
const ADMIN_TOKEN_TTL_SECONDS = 8 * 3600;

/**
 * The control plane signs with its OWN key material (`realm: 'admin'`).
 *
 * Previously this file derived `admin:${secret}` so that a tenant token and a
 * superuser token could never verify against each other even if the audience
 * check were removed or broken. That property is preserved rather than dropped
 * in the move to asymmetric keys: the admin realm reads `ADMIN_JWT_PRIVATE_JWK`
 * and `ADMIN_JWT_PUBLIC_JWKS`, and falls back to the same derived secret while
 * those are unset — so the two planes migrate independently.
 *
 * A single shared key pair would have made `aud` the only thing standing between
 * a tenant session and the control plane. Audience separation (P11) is a real
 * check and does the work; this is the layer underneath, the one that still
 * holds when the layer above has a bug.
 */
const ADMIN_REALM = 'admin' as const;

export class SuperuserAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperuserAuthError';
  }
}

export interface SuperuserClaims {
  sub: string;
  email: string;
  aud: typeof ADMIN_AUDIENCE;
}

/**
 * Login superuser: kata sandi **dan** TOTP, keduanya wajib, dalam satu langkah.
 *
 * Satu langkah, bukan dua, dengan sengaja. Alur dua tahap (kata sandi dulu, lalu
 * minta TOTP) memberi tahu penyerang bahwa kata sandinya benar — dan bagi akun
 * yang memegang kunci ke seluruh platform, informasi itu tidak perlu diberikan.
 */
export async function superuserLogin(input: {
  email: string;
  password: string;
  totp: string;
}): Promise<{ token: string; expiresIn: number }> {
  const db = platformClient();

  const superuser = await db.superuser.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      totpSecret: true,
      isActive: true,
    },
  });

  const passwordOk =
    superuser !== null && (await verifyPassword(input.password, superuser.passwordHash));

  // TOTP tetap diverifikasi meski kata sandi salah, agar waktu respons kedua
  // jalur setara.
  //
  // `epochTolerance: 1` menerima satu langkah waktu sebelum dan sesudah — total
  // jendela ~90 detik. Tanpa toleransi, jam perangkat yang meleset beberapa detik
  // membuat login gagal secara acak; dengan toleransi yang lebih longgar,
  // jendela pemakaian ulang kode yang tercuri ikut melebar.
  const totpOk =
    superuser?.totpSecret != null &&
    verifySync({
      token: input.totp,
      secret: superuser.totpSecret,
      strategy: 'totp',
      epochTolerance: 1,
    }).valid;

  if (!superuser?.isActive || !passwordOk || !totpOk) {
    throw new SuperuserAuthError('Kredensial tidak sah');
  }

  await db.superuser.update({
    where: { id: superuser.id },
    data: { lastLoginAt: new Date() },
  });

  const token = await signJwt(
    { email: superuser.email },
    {
      subject: superuser.id,
      audience: ADMIN_AUDIENCE,
      ttlSeconds: ADMIN_TOKEN_TTL_SECONDS,
      realm: ADMIN_REALM,
    },
  );

  return { token, expiresIn: ADMIN_TOKEN_TTL_SECONDS };
}

export async function verifySuperuserToken(token: string): Promise<SuperuserClaims> {
  try {
    const payload = await verifyJwt(token, ADMIN_AUDIENCE, ADMIN_REALM);
    return {
      sub: String(payload.sub),
      email: String(payload['email']),
      aud: ADMIN_AUDIENCE,
    };
  } catch {
    throw new SuperuserAuthError('Token admin tidak sah');
  }
}

/** Membuat rahasia TOTP baru beserta URI untuk dipindai aplikasi authenticator. */
export function generateTotpSecret(email: string): { secret: string; otpauthUrl: string } {
  const secretValue = generateSecret();
  return {
    secret: secretValue,
    otpauthUrl: generateURI({
      secret: secretValue,
      label: email,
      issuer: 'HRMS Admin',
      strategy: 'totp',
    }),
  };
}
