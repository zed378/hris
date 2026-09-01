import { createHash, randomBytes } from 'node:crypto';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@hrms/contracts';
import { signJwt, verifyJwt, JwtVerificationError } from './jwt.ts';

export const TENANT_AUDIENCE = 'hrms-tenant';
/** Audience control plane. Intentionally never accepted by the tenant gateway (P11). */
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
 * Access token, 15-minute lifetime.
 *
 * The short lifetime is what makes revocation work without a central
 * blocklist: a user whose access has been revoked loses access at most
 * one TTL later, without the gateway needing to check the database on each
 * request.
 *
 * `av` (access version) narrows it further for permission changes —
 * the gateway compares the version in the token against the one on record and
 * rejects stale tokens.
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
 * Verifies a tenant access token.
 *
 * The `audience` is checked explicitly. This is what enforces separation of the
 * two fields: superuser tokens (`hrms-admin`) fail here, so control plane
 * credentials can never be used on tenant data endpoints.
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
      throw new TokenVerificationError('Access token expired', 'expired');
    }
    throw new TokenVerificationError('Invalid access token', 'invalid');
  }
}

/**
 * Refresh token is a random value, not a JWT.
 *
 * The reason: a refresh token must be revocable instantly, which requires a
 * database lookup on every use. If the lookup is needed anyway, signing it as a
 * JWT adds nothing but size.
 *
 * What is stored is its SHA-256 hash. A leaked database gives an attacker not a
 * single usable session.
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
