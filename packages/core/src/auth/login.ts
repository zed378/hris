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
 * THE RULE BINDING THIS WHOLE FILE
 *
 * A `throw` inside `withTenant()` rolls its transaction back. So every side
 * effect that must **survive a rejected request** — the failed attempt counter,
 * the account lock, revoking a token family, the audit trail of a failure —
 * must not be written in a transaction that ends in a throw.
 *
 * The pattern used: the transaction returns an outcome rather than throwing. The
 * caller inspects that outcome, writes the side effects in a transaction of
 * their own that commits, and only then throws.
 *
 * This is not a subtlety of style. The previous version wrote the counter inside
 * the transaction and then threw, and the result was: ten consecutive wrong
 * passwords left `failed_login_attempts = 0`. Account locking appeared to be in
 * the code, passed review, and did nothing. The same thing made refresh token
 * reuse detection return a 401 without ever actually revoking the stolen token.
 * Found by an end-to-end test, not a unit test — both depend on real commit
 * behaviour.
 */

/** Lock the account after this many consecutive failed attempts. */
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
  /** Wrong credentials with no user to penalise (the email does not exist). */
  | { kind: 'rejected' }
  /** Wrong credentials on a real user — the counter must rise. */
  | { kind: 'rejected_with_penalty'; userId: string }
  | { kind: 'locked'; retryAfterSeconds: number };

/**
 * Login with tenantCode + email + password (PLAN/06 §3.2).
 *
 * One rule binds this path: **every failure returns the same
 * `INVALID_CREDENTIALS`**, whatever its cause — no such tenant, no such email,
 * wrong password, or an inactive user. Distinguishing them turns the login
 * endpoint into an enumeration tool: first the valid tenant names, then the
 * valid email addresses inside them.
 *
 * There are two exceptions, and both are deliberate because a legitimate user
 * needs to know: a locked account, and a suspended tenant.
 */
export async function login(
  input: { tenantCode: string; email: string; password: string },
  ctx: LoginContext = {},
): Promise<LoginResult> {
  const tenant = await resolveTenantByCode(input.tenantCode);

  if (!tenant) {
    // Pay the same time cost as a real verification, so a latency difference does
    // not reveal which tenants exist.
    await burnTimingBudget(input.password);
    throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials');
  }

  if (tenant.status === 'SUSPENDED' || tenant.status === 'CHURNED') {
    throw new AuthError(ErrorCode.TENANT_SUSPENDED, 'Company account is temporarily inactive');
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

    // The status is checked AFTER the password is verified. Previously this
    // endpoint told a guesser that a particular email existed but was inactive.
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
        'Account temporarily locked due to too many failed attempts',
        outcome.retryAfterSeconds,
      );

    case 'rejected_with_penalty':
      // A transaction of its own, outside the one that failed. This is what makes
      // the counter genuinely increase and the account lock genuinely apply.
      await withTenant(tenant.id, (tx) =>
        registerFailedAttempt(tx, tenant.id, outcome.userId, ctx),
      );
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials');

    case 'rejected':
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials');
  }
}

/**
 * Increments the failed attempt counter, and locks the account at the threshold.
 *
 * The increment is atomic (`increment`), not read-then-write. Two simultaneous
 * failures on the same account therefore produce two increments rather than one
 * — which means a parallel attacker cannot evade the account lock by sending
 * guesses all at once.
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
  /** The session was legitimately revoked: logout, a password reset, or incident follow-up. */
  | { kind: 'revoked' }
  /** A token that was ALREADY ROTATED is used again — an indication of theft. */
  | { kind: 'reuse'; familyId: string; userId: string };

/**
 * Refresh token rotation with theft detection (PLAN/06 §3.5).
 *
 * Every use issues a new token and marks the old one as rotated. If a token that
 * was ALREADY rotated appears again, there are only two possibilities: it was
 * stolen, or a copy was left behind on another device. Both demand the same
 * response — revoke the **whole family** of tokens and force a fresh login.
 *
 * Revoking the whole family rather than only the reused token is the heart of
 * the mechanism: when theft is detected we do not know which party is
 * legitimate, so both are logged out.
 *
 * A trade-off worth knowing: a user on a poor network whose refresh request
 * times out after the server stored it is logged out too. That is chosen
 * deliberately — a lost session is far cheaper than a stolen one.
 */
export async function refresh(rawToken: string, ctx: LoginContext = {}): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(rawToken);

  // This lookup precedes the tenant context, because the tenant is exactly what
  // is being looked up — RLS would return zero rows if it were read directly. It
  // uses a narrow SECURITY DEFINER function; see migration 20260818035500.
  const found = await appClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.resolve_refresh_token_owner(${tokenHash})
  `;

  const tenantId = found[0]?.tenant_id;
  if (!tenantId) {
    throw new AuthError(ErrorCode.TOKEN_INVALID, 'Invalid refresh token');
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

    // Two states that are easy to conflate, and must not be.
    //
    // A token that was ROTATED and then appears again means two parties hold the
    // same token — that is an indication of theft, and deserves recording as an
    // incident.
    //
    // A REVOKED token only means the session ended legitimately: logout, a
    // password reset, or cleanup after an earlier incident. Marking it as theft
    // makes everyone who forgets their password trigger a security alarm — and an
    // alarm that is often wrong is an alarm that gets ignored when it is right.
    if (stored.replacedByTokenId !== null) {
      return { kind: 'reuse', familyId: stored.familyId, userId: stored.userId };
    }
    if (stored.revokedAt !== null) {
      return { kind: 'revoked' };
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
      // A transaction of its own so the revocation genuinely commits before we
      // throw. Written in the failing transaction, theft detection would return a
      // convincing 401 without revoking a single token.
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
        'Session revoked due to detected token reuse',
      );

    case 'tenant_suspended':
      throw new AuthError(ErrorCode.TENANT_SUSPENDED, 'Company account is temporarily inactive');

    case 'revoked':
      throw new AuthError(
        ErrorCode.TOKEN_EXPIRED,
        'Your session has ended. Please sign in again.',
      );

    case 'expired':
      throw new AuthError(ErrorCode.TOKEN_EXPIRED, 'Refresh token expired');

    case 'invalid':
      throw new AuthError(ErrorCode.TOKEN_INVALID, 'Invalid refresh token');
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

/** Logout: revokes one token family, not only the token being held. */
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
