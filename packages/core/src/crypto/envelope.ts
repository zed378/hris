import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption under a named key ring.
 *
 * Extracted from `employee/pii.ts` when the control plane needed the same thing
 * for superuser TOTP secrets (P6-14). Both now share one implementation with
 * different key names: `PII_ENCRYPTION_KEY` for tenant personal data,
 * `PLATFORM_ENCRYPTION_KEY` for control-plane secrets. Two rings rather than one
 * so a leaked tenant-data key does not also hand over the second factor of every
 * superuser, and the reverse.
 *
 * ## The ring
 *
 * One key that writes (`<NAME>`), several that may read (`<NAME>S_OLD`,
 * comma-separated). Rotation is three ordinary deploys: promote the new key and
 * demote the old one to the read-only list; rewrite every row; remove the old
 * key, after which a row still readable only by it fails loudly — which is the
 * point, because a fallback with no end date keeps a decade-old key alive.
 *
 * ## Why trying keys in turn is sound here, and would not be under CBC
 *
 * AES-GCM is authenticated. Decryption with the wrong key fails the tag
 * essentially always, so "try the next key" is the cipher's decision, not a
 * guess. Under CBC the same loop would be a padding oracle.
 *
 * ## Format
 *
 * `v1.<iv>.<tag>.<ciphertext>`, base64url. A format version, not a key id —
 * which key wrote a row is established by trying the ring.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const KEY_HINT =
  'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';

export function parseKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes in base64 (got ${key.length} bytes).`);
  }
  return key;
}

export function keyFrom(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set. ${KEY_HINT}`);
  return parseKey(raw, name);
}

/** The primary key first, then every read-only key. */
export function keyRing(primaryName: string, oldName: string): Buffer[] {
  const ring = [keyFrom(primaryName)];
  for (const raw of (process.env[oldName] ?? '').split(',')) {
    if (raw.trim() === '') continue;
    ring.push(parseKey(raw, oldName));
  }
  return ring;
}

/** Encrypts with the primary key of the ring. */
export function seal(plain: string, primaryName: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyFrom(primaryName), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** True when `value` has the sealed format. It says nothing about which key sealed it. */
export function isSealed(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === 'v1' && parts.every((part) => part.length > 0);
}

/** Thrown when no key on the ring can read a value. */
export class UndecryptableError extends Error {
  constructor(readonly keysTried: number) {
    super(
      `Encrypted data is unreadable with the ${keysTried} configured key(s). ` +
        'Most likely an old key was removed before rotation finished, ' +
        'or this row comes from another database.',
    );
    this.name = 'UndecryptableError';
  }
}

export function open(encoded: string, primaryName: string, oldName: string): string {
  const [version, ivPart, tagPart, dataPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Unknown encrypted data format');
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');
  const ring = keyRing(primaryName, oldName);

  for (const key of ring) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      // The GCM tag rejected this key. A stale row during a rotation window is
      // expected; only exhausting the ring is worth reporting.
    }
  }

  throw new UndecryptableError(ring.length);
}

/** True when the value was written by the PRIMARY key and needs no rewrite. */
export function sealedWithPrimary(encoded: string, primaryName: string): boolean {
  const [version, ivPart, tagPart, dataPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return false;

  try {
    const decipher = createDecipheriv(ALGORITHM, keyFrom(primaryName), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    decipher.update(Buffer.from(dataPart, 'base64url'));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}
