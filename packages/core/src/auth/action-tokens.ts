import { createHash, randomBytes } from 'node:crypto';
import { appClient, withTenant, type TenantClient } from '@hrms/db';

/**
 * One-time tokens for password reset and user invitations.
 *
 * Both share the exact same shape — random value, single user, expiry,
 * single-use — so they share one table and one code path. The only difference
 * is the expiry.
 *
 * That difference is deliberate: password reset is triggered by someone sitting
 * at the screen waiting for the email, while invitations go to someone who may
 * be on vacation. One hour is too short for the latter; seven days too loose for
 * the former.
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
 * Consumes a token: validates it, marks it used, then runs `apply` within the
 * same transaction.
 *
 * The marking and its effect must commit together. If separated, two concurrent
 * requests with the same token can both pass validation before either marks it —
 * and a one-time token ceases to be one-time. The conditional `updateMany` with
 * `usedAt: null` ensures only one succeeds, and the second sees `count === 0`.
 */
export async function consumeActionToken<T>(
  rawToken: string,
  purpose: ActionTokenPurpose,
  apply: (tx: TenantClient, token: ConsumedToken) => Promise<T>,
): Promise<T> {
  const tokenHash = hashActionToken(rawToken);

  // The tenant is not yet known when the token arrives, so the context cannot be
  // set and RLS would return zero rows. Uses a narrow SECURITY DEFINER function;
  // see migration 20260818074552.
  const found = await appClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.resolve_action_token_owner(${tokenHash})
  `;
  const tenantId = found[0]?.tenant_id;
  if (!tenantId)     throw new ActionTokenError('Invalid or expired link');

  return withTenant(tenantId, async (tx) => {
    const claimed = await tx.actionToken.updateMany({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw new ActionTokenError('Invalid or expired link');
    }

    const token = await tx.actionToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { tenantId: true, userId: true },
    });

    return apply(tx, token);
  });
}
