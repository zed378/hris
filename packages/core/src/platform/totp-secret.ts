import { platformClient } from '@hrms/db';
import { log } from '@hrms/observability';
import { isSealed, open, seal, sealedWithPrimary } from '../crypto/index.ts';

/**
 * Superuser TOTP secrets, encrypted at rest (P6-14, risk F13, `docs/SECURITY/02` §9(c)).
 *
 * A TOTP secret is the second factor itself: anyone who reads it generates valid
 * codes forever. Stored in plaintext, a read of `platform.superusers` — a backup,
 * a replica, an over-broad grant — turned two factors into one password away
 * from the whole control plane.
 *
 * The control plane has its own ring, `PLATFORM_ENCRYPTION_KEY` /
 * `PLATFORM_ENCRYPTION_KEYS_OLD`, separate from the tenant PII ring: one leaked
 * key must not open both planes.
 *
 * Plaintext rows still read. Base32 secrets never contain `.`, so a plaintext
 * secret can never be mistaken for the sealed `v1.…` format. They are sealed by
 * `sealTotpSecrets` and, failing that, on the superuser's next successful login.
 */

const KEY = 'PLATFORM_ENCRYPTION_KEY';
const OLD_KEYS = 'PLATFORM_ENCRYPTION_KEYS_OLD';

export function sealTotpSecret(secret: string): string {
  return seal(secret, KEY);
}

/** The usable secret, whether the stored value is sealed or still plaintext. */
export function readTotpSecret(stored: string): string {
  return isSealed(stored) ? open(stored, KEY, OLD_KEYS) : stored;
}

/** True when the stored value needs (re)writing: plaintext, or sealed by a demoted key. */
export function needsSealing(stored: string): boolean {
  return !isSealed(stored) || !sealedWithPrimary(stored, KEY);
}

/**
 * Seals every plaintext secret and re-seals any written by a demoted key.
 *
 * Re-runnable and interruptible: a row already sealed with the primary key is
 * left alone, so a second run is a no-op. This is both the migration of existing
 * plaintext rows and step 2 of a key rotation.
 */
export async function sealTotpSecrets(): Promise<{ sealed: number; total: number }> {
  const db = platformClient();
  const rows = await db.superuser.findMany({
    where: { totpSecret: { not: null } },
    select: { id: true, totpSecret: true },
  });

  let sealed = 0;
  for (const row of rows) {
    if (!row.totpSecret || !needsSealing(row.totpSecret)) continue;
    await db.superuser.update({
      where: { id: row.id },
      data: { totpSecret: sealTotpSecret(readTotpSecret(row.totpSecret)) },
    });
    sealed += 1;
  }

  log.info({ scope: 'platform', event: 'totp-secrets-sealed', sealed, total: rows.length });
  return { sealed, total: rows.length };
}
