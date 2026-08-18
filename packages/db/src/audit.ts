import type { TenantClient } from './tenant-context.ts';

export interface AuditEntry {
  /** Verba lampau, bertitik: `user.logged_in`, `role.permission_granted`. */
  action: string;
  entityType: string;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  /** Hanya kolom yang berubah, bukan seluruh baris. */
  before?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/** Kolom yang tidak boleh masuk jejak audit dalam keadaan apa pun. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'token_hash',
  'refreshToken',
  'accessToken',
  'totpSecret',
  'totp_secret',
  'secret',
]);

function redact(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : item;
  }
  return out;
}

/**
 * Menulis satu baris jejak audit.
 *
 * Dipanggil **di dalam transaksi bisnis yang sama**, bukan setelahnya. Audit yang
 * ditulis di transaksi terpisah dapat gagal sendirian, dan yang tersisa adalah
 * perubahan data tanpa jejak — persis keadaan yang hendak dicegah (P5).
 *
 * Tabel tujuannya append-only: hak UPDATE/DELETE dicabut dan sebuah trigger
 * menolak keduanya bahkan bagi pemilik tabel.
 */
export async function writeAudit(
  tx: TenantClient,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      actorUserId: entry.actorUserId ?? null,
      before: (redact(entry.before) ?? null) as never,
      after: (redact(entry.after) ?? null) as never,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      correlationId: entry.correlationId ?? null,
    },
  });
}
