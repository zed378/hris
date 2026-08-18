import { randomUUID } from 'node:crypto';
import { appClient, withTenant, writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import { ErrorCode, EventTopic, type TokenPair } from '@hrms/contracts';
import { resolveTenantByCode } from '../tenant/index.ts';
import { resolveEffectiveAccess } from '../iam/index.ts';
import { burnTimingBudget, verifyPassword } from './password.ts';
import {
  accessTokenTtlSeconds,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  refreshTtlDays,
} from './tokens.ts';

/**
 * ATURAN YANG MENGIKAT SELURUH BERKAS INI
 *
 * Sebuah `throw` di dalam `withTenant()` mem-*rollback* transaksinya. Karena itu
 * setiap efek samping yang harus **bertahan meski request ditolak** — penghitung
 * percobaan gagal, kunci akun, pencabutan keluarga token, jejak audit kegagalan —
 * tidak boleh ditulis di transaksi yang berakhir dengan lemparan.
 *
 * Pola yang dipakai: transaksi mengembalikan *outcome*, bukan melempar. Pemanggil
 * memeriksa outcome-nya, menulis efek samping dalam transaksi tersendiri yang
 * commit, baru melempar.
 *
 * Ini bukan kehalusan gaya. Versi sebelumnya menulis penghitung di dalam
 * transaksi lalu melempar, dan hasilnya: sepuluh percobaan kata sandi salah
 * berturut-turut meninggalkan `failed_login_attempts = 0`. Kunci akun tampak
 * ada di kode, lulus review, dan tidak melakukan apa pun. Hal yang sama membuat
 * deteksi pemakaian ulang refresh token mengembalikan 401 tanpa pernah benar-benar
 * mencabut token yang dicuri.
 *
 * Ditemukan uji end-to-end, bukan uji unit — keduanya bergantung pada perilaku
 * commit sungguhan.
 */

/** Kunci akun setelah sekian percobaan gagal berturut-turut. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    readonly code: (typeof ErrorCode)[keyof typeof ErrorCode],
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface LoginContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

export interface LoginResult extends TokenPair {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; code: string };
}

type LoginOutcome =
  | { kind: 'ok'; result: LoginResult }
  /** Kredensial salah tanpa pengguna yang dapat dihukum (email tidak ada). */
  | { kind: 'rejected' }
  /** Kredensial salah pada pengguna nyata — penghitung wajib naik. */
  | { kind: 'rejected_with_penalty'; userId: string }
  | { kind: 'locked'; retryAfterSeconds: number };

/**
 * Login dengan tenantCode + email + password (PLAN/06 §3.2).
 *
 * Satu aturan mengikat jalur ini: **setiap kegagalan mengembalikan
 * `INVALID_CREDENTIALS` yang sama**, apa pun sebabnya — tenant tidak ada, email
 * tidak ada, kata sandi salah, atau pengguna belum aktif. Membedakannya mengubah
 * endpoint login menjadi alat pencacah: nama tenant yang sah, lalu alamat email
 * yang sah di dalamnya.
 *
 * Pengecualiannya dua, dan keduanya disengaja karena pengguna yang sah perlu
 * tahu: akun terkunci, dan tenant ditangguhkan.
 */
export async function login(
  input: { tenantCode: string; email: string; password: string },
  ctx: LoginContext = {},
): Promise<LoginResult> {
  const tenant = await resolveTenantByCode(input.tenantCode);

  if (!tenant) {
    // Bayar biaya waktu yang sama seperti verifikasi sungguhan, supaya selisih
    // latensi tidak membocorkan tenant mana yang ada.
    await burnTimingBudget(input.password);
    throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Kredensial tidak sah');
  }

  if (tenant.status === 'SUSPENDED' || tenant.status === 'CHURNED') {
    throw new AuthError(ErrorCode.TENANT_SUSPENDED, 'Akun perusahaan sedang tidak aktif');
  }

  const outcome = await withTenant(tenant.id, async (tx): Promise<LoginOutcome> => {
    const user = await tx.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      select: {
        id: true,
        email: true,
        fullName: true,
        passwordHash: true,
        status: true,
        lockedUntil: true,
      },
    });

    if (!user) {
      await burnTimingBudget(input.password);
      return { kind: 'rejected' };
    }

    const now = new Date();

    if (user.lockedUntil && user.lockedUntil > now) {
      return {
        kind: 'locked',
        retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000),
      };
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      return { kind: 'rejected_with_penalty', userId: user.id };
    }

    // Status diperiksa SETELAH kata sandi diverifikasi. Sebelumnya, endpoint ini
    // memberi tahu penebak bahwa email tertentu ada tetapi belum aktif.
    if (user.status !== 'ACTIVE') {
      return { kind: 'rejected' };
    }

    const tenantRow = await tx.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { code: true },
    });

    const access = await resolveEffectiveAccess(tx, tenant.id, user.id);

    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });

    const refreshToken = generateRefreshToken();
    await tx.refreshToken.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: refreshToken.hash,
        familyId: randomUUID(),
        expiresAt: new Date(now.getTime() + refreshTtlDays() * 86_400_000),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      },
    });

    const accessToken = await issueAccessToken({
      userId: user.id,
      tenantId: tenant.id,
      tenantCode: tenantRow.code,
      email: user.email,
      accessVersion: access.accessVersion,
    });

    await writeAudit(tx, tenant.id, {
      action: 'auth.login.succeeded',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });

    await publishEvent(tx, tenant.id, {
      topic: EventTopic.USER_LOGGED_IN,
      payload: {
        tenantId: tenant.id,
        userId: user.id,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      correlationId: ctx.correlationId,
    });

    return {
      kind: 'ok',
      result: {
        accessToken,
        refreshToken: refreshToken.raw,
        expiresIn: accessTokenTtlSeconds(),
        tokenType: 'Bearer' as const,
        user: { id: user.id, email: user.email, fullName: user.fullName },
        tenant: { id: tenant.id, code: tenantRow.code },
      },
    };
  });

  switch (outcome.kind) {
    case 'ok':
      return outcome.result;

    case 'locked':
      throw new AuthError(
        ErrorCode.ACCOUNT_LOCKED,
        'Akun terkunci sementara karena terlalu banyak percobaan gagal',
        outcome.retryAfterSeconds,
      );

    case 'rejected_with_penalty':
      // Transaksi tersendiri, di luar transaksi yang gagal. Inilah yang membuat
      // penghitung benar-benar bertambah dan kunci akun benar-benar terpasang.
      await withTenant(tenant.id, (tx) =>
        registerFailedAttempt(tx, tenant.id, outcome.userId, ctx),
      );
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Kredensial tidak sah');

    case 'rejected':
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Kredensial tidak sah');
  }
}

/**
 * Menaikkan penghitung percobaan gagal, dan mengunci akun bila ambang tercapai.
 *
 * Kenaikannya atomik (`increment`), bukan baca-lalu-tulis. Dua percobaan gagal
 * bersamaan pada akun yang sama karenanya menghasilkan dua kenaikan, bukan satu —
 * yang berarti penyerang paralel tidak dapat menghindari kunci akun dengan
 * mengirim tebakan secara serentak.
 */
async function registerFailedAttempt(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  ctx: LoginContext,
): Promise<void> {
  const updated = await tx.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });

  const shouldLock = updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS;
  if (shouldLock) {
    await tx.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
    });
  }

  await writeAudit(tx, tenantId, {
    action: shouldLock ? 'auth.login.locked' : 'auth.login.failed',
    entityType: 'user',
    entityId: userId,
    actorUserId: userId,
    after: { failedLoginAttempts: updated.failedLoginAttempts },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });
}

type RefreshOutcome =
  | { kind: 'ok'; tokens: TokenPair }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'tenant_suspended' }
  /** Token yang sudah digantikan atau dicabut dipakai lagi — indikasi pencurian. */
  | { kind: 'reuse'; familyId: string; userId: string };

/**
 * Rotasi refresh token dengan deteksi pencurian (PLAN/06 §3.5).
 *
 * Setiap pemakaian menerbitkan token baru dan menandai yang lama sudah digantikan.
 * Bila token yang SUDAH digantikan muncul lagi, hanya ada dua kemungkinan: token
 * itu dicuri, atau salinannya tertinggal di perangkat lain. Keduanya menuntut
 * respons yang sama — cabut **seluruh keluarga** token dan paksa login ulang.
 *
 * Mencabut seluruh keluarga, bukan hanya token yang dipakai ulang, adalah inti
 * mekanismenya: saat pencurian terdeteksi kita tidak tahu pihak mana yang sah,
 * sehingga keduanya dikeluarkan.
 *
 * Kompromi yang perlu diketahui: pengguna dengan jaringan buruk yang request
 * refresh-nya timeout setelah server menyimpannya akan ikut tercabut. Itu
 * dipilih sadar — sesi yang hilang jauh lebih murah daripada sesi yang dicuri.
 */
export async function refresh(rawToken: string, ctx: LoginContext = {}): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(rawToken);

  // Pencarian ini mendahului konteks tenant, karena tenant justru yang hendak
  // dicari — RLS akan mengembalikan nol baris bila dibaca langsung. Memakai
  // fungsi SECURITY DEFINER sempit; lihat migrasi 20260818035500.
  const found = await appClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.resolve_refresh_token_owner(${tokenHash})
  `;

  const tenantId = found[0]?.tenant_id;
  if (!tenantId) {
    throw new AuthError(ErrorCode.TOKEN_INVALID, 'Refresh token tidak sah');
  }

  const outcome = await withTenant(tenantId, async (tx): Promise<RefreshOutcome> => {
    const stored = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        replacedByTokenId: true,
        user: { select: { email: true, status: true } },
      },
    });

    if (!stored) return { kind: 'invalid' };

    if (stored.replacedByTokenId !== null || stored.revokedAt !== null) {
      return { kind: 'reuse', familyId: stored.familyId, userId: stored.userId };
    }

    if (stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
      return { kind: 'expired' };
    }

    const tenantRow = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { code: true, status: true },
    });
    if (tenantRow.status === 'SUSPENDED' || tenantRow.status === 'CHURNED') {
      return { kind: 'tenant_suspended' };
    }

    const access = await resolveEffectiveAccess(tx, tenantId, stored.userId);
    const next = generateRefreshToken();

    const created = await tx.refreshToken.create({
      data: {
        tenantId,
        userId: stored.userId,
        tokenHash: next.hash,
        familyId: stored.familyId,
        expiresAt: new Date(Date.now() + refreshTtlDays() * 86_400_000),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      },
      select: { id: true },
    });

    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { replacedByTokenId: created.id },
    });

    const accessToken = await issueAccessToken({
      userId: stored.userId,
      tenantId,
      tenantCode: tenantRow.code,
      email: stored.user.email,
      accessVersion: access.accessVersion,
    });

    return {
      kind: 'ok',
      tokens: {
        accessToken,
        refreshToken: next.raw,
        expiresIn: accessTokenTtlSeconds(),
        tokenType: 'Bearer' as const,
      },
    };
  });

  switch (outcome.kind) {
    case 'ok':
      return outcome.tokens;

    case 'reuse':
      // Transaksi tersendiri agar pencabutan benar-benar commit sebelum kita
      // melempar. Bila ditulis di transaksi yang gagal, deteksi pencurian akan
      // mengembalikan 401 yang meyakinkan tanpa mencabut satu token pun.
      await withTenant(tenantId, async (tx) => {
        await revokeFamily(tx, tenantId, outcome.familyId, 'reuse_detected');
        await writeAudit(tx, tenantId, {
          action: 'auth.token.reuse_detected',
          entityType: 'refresh_token_family',
          entityId: outcome.familyId,
          actorUserId: outcome.userId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          correlationId: ctx.correlationId,
        });
      });
      throw new AuthError(
        ErrorCode.TOKEN_REUSE_DETECTED,
        'Sesi dicabut karena terdeteksi pemakaian ulang token',
      );

    case 'tenant_suspended':
      throw new AuthError(ErrorCode.TENANT_SUSPENDED, 'Akun perusahaan sedang tidak aktif');

    case 'expired':
      throw new AuthError(ErrorCode.TOKEN_EXPIRED, 'Refresh token kedaluwarsa');

    case 'invalid':
      throw new AuthError(ErrorCode.TOKEN_INVALID, 'Refresh token tidak sah');
  }
}

async function revokeFamily(
  tx: TenantClient,
  tenantId: string,
  familyId: string,
  reason: string,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { tenantId, familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Logout: mencabut satu keluarga token, bukan hanya token yang dipegang. */
export async function logout(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  const found = await appClient().$queryRaw<Array<{ tenant_id: string; family_id: string }>>`
    SELECT tenant_id, family_id FROM public.resolve_refresh_token_owner(${tokenHash})
  `;
  const row = found[0];
  if (!row) return;

  await withTenant(row.tenant_id, async (tx) => {
    await revokeFamily(tx, row.tenant_id, row.family_id, 'logout');
  });
}
