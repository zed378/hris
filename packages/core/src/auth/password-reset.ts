import { withTenant, writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import { resolveTenantByCode } from '../tenant/index.ts';
import { hashPassword } from './password.ts';
import { consumeActionToken, issueActionToken, ActionTokenError } from './action-tokens.ts';

/**
 * Reset kata sandi.
 *
 * Dua sifat yang mengikat alur ini:
 *
 * 1. **Permintaan reset tidak pernah membocorkan apakah akunnya ada.** Balasan
 *    dan waktu responsnya sama untuk email yang terdaftar maupun tidak. Bila
 *    berbeda, endpoint ini menjadi alat pencacah alamat email karyawan sebuah
 *    perusahaan — dan itu justru daftar yang paling berguna bagi penyerang.
 *
 * 2. **Reset yang berhasil mencabut seluruh sesi.** Orang menekan "lupa kata
 *    sandi" justru ketika mereka menduga akunnya dipakai orang lain. Membiarkan
 *    sesi lama tetap hidup membuat penggantian kata sandi terasa menyelesaikan
 *    masalah tanpa benar-benar menyelesaikannya.
 */

export interface ResetRequestContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/**
 * Meminta tautan reset.
 *
 * Selalu berakhir tanpa galat. Token yang diterbitkan dikembalikan hanya untuk
 * diteruskan ke `notification-service`; pemanggil HTTP tidak pernah melihatnya.
 */
export async function requestPasswordReset(
  input: { tenantCode: string; email: string },
  ctx: ResetRequestContext = {},
): Promise<void> {
  const tenant = await resolveTenantByCode(input.tenantCode);
  if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'CHURNED') return;

  await withTenant(tenant.id, async (tx) => {
    const user = await tx.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      select: { id: true, status: true },
    });

    // Pengguna berstatus INVITED sengaja tidak dilayani di sini: mereka belum
    // pernah punya kata sandi, dan jalurnya adalah menerima undangan.
    if (!user || user.status !== 'ACTIVE') return;

    const token = await issueActionToken(tx, {
      tenantId: tenant.id,
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      ip: ctx.ip,
    });

    await writeAudit(tx, tenant.id, {
      action: 'auth.password.reset_requested',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });

    // Email dikirim konsumer event, bukan di jalur request. Kegagalan penyedia
    // email tidak boleh membuat endpoint ini gagal — dan bila gagal pun,
    // pesannya tetap terkirim setelah antrean pulih.
    await publishEvent(tx, tenant.id, {
      topic: 'auth.password.reset_requested',
      payload: {
        tenantId: tenant.id,
        userId: user.id,
        token: token.raw,
        expiresAt: token.expiresAt.toISOString(),
      },
      correlationId: ctx.correlationId,
    });
  });
}

/** Menyelesaikan reset dengan token dari email. */
export async function completePasswordReset(
  input: { token: string; newPassword: string },
  ctx: ResetRequestContext = {},
): Promise<void> {
  const passwordHash = await hashPassword(input.newPassword);

  await consumeActionToken(input.token, 'PASSWORD_RESET', async (tx, token) => {
    await tx.user.update({
      where: { id: token.userId },
      data: {
        passwordHash,
        // Kunci akun ikut dilepas. Seseorang yang lupa kata sandinya sangat
        // mungkin sudah salah delapan kali sebelum menyerah dan menekan tautan.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await revokeAllSessions(tx, token.tenantId, token.userId, 'password_reset');

    await writeAudit(tx, token.tenantId, {
      action: 'auth.password.reset_completed',
      entityType: 'user',
      entityId: token.userId,
      actorUserId: token.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
  });
}

/** Menerima undangan: memasang kata sandi pertama dan mengaktifkan akun. */
export async function acceptInvitation(
  input: { token: string; password: string },
  ctx: ResetRequestContext = {},
): Promise<{ tenantCode: string; email: string }> {
  const passwordHash = await hashPassword(input.password);

  return consumeActionToken(input.token, 'INVITATION', async (tx, token) => {
    const user = await tx.user.update({
      where: { id: token.userId },
      data: { passwordHash, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null },
      select: { email: true },
    });

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: token.tenantId },
      select: { code: true },
    });

    await writeAudit(tx, token.tenantId, {
      action: 'iam.invitation.accepted',
      entityType: 'user',
      entityId: token.userId,
      actorUserId: token.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });

    return { tenantCode: tenant.code, email: user.email };
  });
}

async function revokeAllSessions(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  reason: string,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { tenantId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export { ActionTokenError };
