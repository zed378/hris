import { createHash, randomBytes } from 'node:crypto';
import { appClient, withTenant, type TenantClient } from '@hrms/db';

/**
 * Token sekali pakai untuk reset kata sandi dan undangan pengguna.
 *
 * Keduanya berbagi bentuk yang persis sama — nilai acak, satu pengguna, masa
 * berlaku, sekali pakai — sehingga berbagi satu tabel dan satu potong kode.
 * Yang berbeda hanya masa berlakunya.
 *
 * Perbedaan masa berlaku itu sendiri disengaja: reset kata sandi dipicu oleh
 * orang yang sedang duduk di depan layar dan menunggu emailnya, sedangkan
 * undangan dikirim ke orang yang mungkin sedang cuti. Satu jam terlalu pendek
 * untuk yang kedua; tujuh hari terlalu longgar untuk yang pertama.
 */

export type ActionTokenPurpose = 'PASSWORD_RESET' | 'INVITATION';

const TTL_MS: Record<ActionTokenPurpose, number> = {
  PASSWORD_RESET: 60 * 60 * 1000,
  INVITATION: 7 * 24 * 60 * 60 * 1000,
};

export function hashActionToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Menerbitkan token baru dan **membatalkan token sebelumnya** untuk keperluan
 * yang sama.
 *
 * Pembatalan itu penting: tanpa ia, menekan "lupa kata sandi" lima kali
 * meninggalkan lima token sah sekaligus, dan yang paling lama tetap berlaku
 * satu jam penuh setelah pemiliknya lupa ia pernah menekannya.
 */
export async function issueActionToken(
  tx: TenantClient,
  input: {
    tenantId: string;
    userId: string;
    purpose: ActionTokenPurpose;
    createdBy?: string | undefined;
    ip?: string | undefined;
  },
): Promise<{ raw: string; expiresAt: Date }> {
  await tx.actionToken.updateMany({
    where: { userId: input.userId, purpose: input.purpose, usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS[input.purpose]);

  await tx.actionToken.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashActionToken(raw),
      expiresAt,
      createdBy: input.createdBy ?? null,
      ip: input.ip ?? null,
    },
  });

  return { raw, expiresAt };
}

export interface ConsumedToken {
  tenantId: string;
  userId: string;
}

export class ActionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionTokenError';
  }
}

/**
 * Memakai token: memvalidasi, menandainya terpakai, lalu menjalankan `apply`
 * dalam transaksi yang sama.
 *
 * Penandaan dan efeknya harus commit bersama. Bila dipisah, dua request yang
 * tiba bersamaan dengan token yang sama dapat sama-sama lolos validasi sebelum
 * salah satunya sempat menandainya — dan token sekali pakai berhenti menjadi
 * sekali pakai. `updateMany` berkondisi `usedAt: null` membuat hanya satu yang
 * berhasil, dan yang kedua melihat `count === 0`.
 */
export async function consumeActionToken<T>(
  rawToken: string,
  purpose: ActionTokenPurpose,
  apply: (tx: TenantClient, token: ConsumedToken) => Promise<T>,
): Promise<T> {
  const tokenHash = hashActionToken(rawToken);

  // Tenantnya belum diketahui saat token masuk, sehingga konteks belum dapat
  // dipasang dan RLS akan mengembalikan nol baris. Fungsi SECURITY DEFINER
  // sempit; lihat migrasi 20260818074552.
  const found = await appClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.resolve_action_token_owner(${tokenHash})
  `;
  const tenantId = found[0]?.tenant_id;
  if (!tenantId) throw new ActionTokenError('Tautan tidak sah atau sudah kedaluwarsa');

  return withTenant(tenantId, async (tx) => {
    const claimed = await tx.actionToken.updateMany({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw new ActionTokenError('Tautan tidak sah atau sudah kedaluwarsa');
    }

    const token = await tx.actionToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { tenantId: true, userId: true },
    });

    return apply(tx, token);
  });
}
