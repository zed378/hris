import { SignJWT, jwtVerify } from 'jose';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { platformClient } from '@hrms/db';
import { verifyPassword } from '../auth/index.ts';

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

const ISSUER = 'hrms';
export const ADMIN_AUDIENCE = 'hrms-admin';
/** Sesi 8 jam, jauh lebih pendek dari sesi tenant. */
const ADMIN_TOKEN_TTL_SECONDS = 8 * 3600;

function secret(): Uint8Array {
  const value = process.env['ADMIN_JWT_SECRET'] ?? process.env['JWT_SECRET'];
  if (!value || value.length < 32) {
    throw new Error('ADMIN_JWT_SECRET belum dipasang atau kurang dari 32 karakter.');
  }
  // Rahasia admin diturunkan berbeda meski nilainya sama, sehingga token tenant
  // dan token admin tidak pernah dapat saling diverifikasi walau salah konfigurasi.
  return new TextEncoder().encode(`admin:${value}`);
}

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

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: superuser.email })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(superuser.id)
    .setIssuer(ISSUER)
    .setAudience(ADMIN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ADMIN_TOKEN_TTL_SECONDS)
    .sign(secret());

  return { token, expiresIn: ADMIN_TOKEN_TTL_SECONDS };
}

export async function verifySuperuserToken(token: string): Promise<SuperuserClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: ADMIN_AUDIENCE,
      algorithms: ['HS256'],
    });
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
