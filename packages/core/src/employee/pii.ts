import { createHmac, timingSafeEqual } from 'node:crypto';
import { keyFrom, keyRing, open, seal, sealedWithPrimary, UndecryptableError } from '../crypto/index.ts';

/**
 * Personal data encryption and masking.
 *
 * Three columns are treated specially: the national ID, the tax ID, and the bank
 * account number. Those three plus a name and a date of birth are enough to take
 * out a loan in someone's name. A leaked database must not hand them over
 * (Personal Data Protection Act No. 27/2022).
 *
 * Two layers with different purposes, and both are needed:
 *
 *   Encryption protects against a database dump, a misplaced backup, and a
 *             leaked read replica. Its key is not in the database.
 *   Masking    protects against eyes with no right to look — an HR intern
 *             opening the employee list need not see anyone's full national ID.
 *
 * Neither replaces the other: encryption does not help when the application
 * decrypts and shows the value to everyone, and masking does not help when the
 * database itself can be read.
 */

/**
 * The key ring and the cipher live in `../crypto` (shared with the control
 * plane's TOTP secrets since P6-14); this module names its keys.
 *
 * `PII_ENCRYPTION_KEY` is the only key that ENCRYPTS; `PII_ENCRYPTION_KEYS_OLD`
 * may only DECRYPT. Rotation: promote the new key and demote the old one; rewrite
 * every row whose `isEncryptedWithPrimaryKey` is false
 * (`pnpm --filter @hrms/worker pii:rotate`, runbook §8); remove the old key.
 *
 * GCM rather than CBC: it is authenticated, so altered ciphertext fails to
 * decrypt instead of yielding garbage plaintext that reaches a payroll report.
 */
export function encryptPii(plain: string): string {
  return seal(plain, 'PII_ENCRYPTION_KEY');
}

export { UndecryptableError };

export function decryptPii(encoded: string): string {
  return open(encoded, 'PII_ENCRYPTION_KEY', 'PII_ENCRYPTION_KEYS_OLD');
}

/** True when the value was written by the PRIMARY key and needs no rewrite. */
export function isEncryptedWithPrimaryKey(encoded: string): boolean {
  return sealedWithPrimary(encoded, 'PII_ENCRYPTION_KEY');
}

/**
 * The blind index: an HMAC of the normalised value.
 *
 * Correct encryption is randomised — the same national ID produces different
 * ciphertext every time. That property is what makes it safe, and also what
 * makes `UNIQUE(national_id)` and "find this national ID" impossible.
 *
 * A blind index solves that: a deterministic value that can be indexed and
 * compared but not reversed. Its key is deliberately DIFFERENT from the
 * encryption key — if they were the same, one leaked key would break two defences.
 *
 * Its limit has to be acknowledged: being deterministic, an attacker holding the
 * database can test whether a particular national ID is in it, provided they also
 * hold the index key. They still cannot enumerate the national IDs.
 */
export function blindIndex(value: string): string {
  return createHmac('sha256', keyFrom('PII_INDEX_KEY'))
    .update(normalizeIdentifier(value))
    .digest('base64url');
}

/**
 * Every index value that could represent this identifier, newest key first.
 *
 * Used for LOOKUP, where `blindIndex` is used for WRITING. During an index-key
 * rotation the two disagree on purpose: rows written before the rotation carry
 * an index under the old key, and a lookup that only computed the new one would
 * report "this national ID is not in the system" for an employee who plainly is.
 *
 * That failure would be silent and would arrive in the worst possible place —
 * the Excel importer treats "not found" as "create", so a rotation window would
 * quietly produce a duplicate employee record for every returning person.
 *
 * ## The hole this does NOT close
 *
 * `UNIQUE (tenant_id, national_id_index)` compares stored values, and stored
 * values under two different keys never collide. So during the window between
 * rotating `PII_INDEX_KEY` and finishing the re-index job, the database will
 * accept two rows holding the SAME national ID — one indexed old, one new — and
 * the constraint that exists to prevent exactly that cannot see it.
 *
 * Application-level checks (`findByNationalId`, the importer's duplicate scan)
 * do close it, because they consult every candidate. The database does not, and
 * a bulk load that writes without going through them would not be caught.
 *
 * The mitigation is procedural rather than technical, and it is in the runbook:
 * an index-key rotation runs to completion in one maintenance window, with
 * employee writes paused. An encryption-key rotation has no such requirement —
 * it can run for days under live traffic — and the two must not be conflated
 * simply because they look alike.
 */
export function blindIndexCandidates(value: string): string[] {
  const normalized = normalizeIdentifier(value);

  return keyRing('PII_INDEX_KEY', 'PII_INDEX_KEYS_OLD').map((key) =>
    createHmac('sha256', key).update(normalized).digest('base64url'),
  );
}

/** True when this stored index was computed with the PRIMARY key. */
export function isIndexedWithPrimaryKey(value: string, storedIndex: string): boolean {
  return blindIndex(value) === storedIndex;
}

/** Strips separators so "3201.1234.5678.9012" and "3201123456789012" match. */
export function normalizeIdentifier(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}

export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

// -----------------------------------------------------------------------------
// Masking
//
// It leaves enough characters to confirm "yes, this is the person I meant", but
// not enough to copy onto any form.
// -----------------------------------------------------------------------------

/** National ID: 16 digits → `3201********9012`. */
export function maskNationalId(value: string): string {
  const digits = normalizeIdentifier(value);
  if (digits.length < 8) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
}

/** Tax ID: leaves the last three digits. */
export function maskTaxId(value: string): string {
  const digits = normalizeIdentifier(value);
  if (digits.length < 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

/**
 * Bank account: leaves the last four digits.
 *
 * Four digits is what a bank normally prints on a receipt, so it is enough to
 * match against without giving whoever sees it anything more.
 */
export function maskBankAccount(value: string): string {
  const digits = normalizeIdentifier(value);
  if (digits.length < 5) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export interface PiiFields {
  nationalId: string | null;
  taxId: string | null;
  bankAccount: string | null;
}

/** The stored shape: ciphertext paired with its masked version. */
export interface StoredPii {
  nationalIdEncrypted: string | null;
  nationalIdMasked: string | null;
  taxIdEncrypted: string | null;
  taxIdMasked: string | null;
  bankAccountEncrypted: string | null;
  bankAccountMasked: string | null;
}

/**
 * Prepares PII for display, according to the reader's permission.
 *
 * `canUnmask` comes from the `employee.pii.unmask` permission the gateway has
 * already checked.
 *
 * Note that **decryption only happens when the permission is present**. The path
 * without the permission reads the stored masked column and does not touch the
 * encryption key at all.
 *
 * The first version of this function decrypted first and then masked the result —
 * apparently equivalent, but it meant every employee's full national ID was in
 * process memory every time the employee list was opened. From there it joins
 * the first error log, heap dump, or APM trace that catches it.
 */
export function revealPii(stored: StoredPii, canUnmask: boolean): PiiFields {
  if (!canUnmask) {
    return {
      nationalId: stored.nationalIdMasked,
      taxId: stored.taxIdMasked,
      bankAccount: stored.bankAccountMasked,
    };
  }

  return {
    nationalId: stored.nationalIdEncrypted && decryptPii(stored.nationalIdEncrypted),
    taxId: stored.taxIdEncrypted && decryptPii(stored.taxIdEncrypted),
    bankAccount: stored.bankAccountEncrypted && decryptPii(stored.bankAccountEncrypted),
  };
}

/** Prepares one PII value for storage: ciphertext, blind index, and mask. */
/**
 * The characters used to mask PII across the system.
 *
 * `*` comes from the Excel export; `•` from the on-screen display. Both have to
 * be here — the first version of this guard only checked `*`, so a value copied
 * from the GRID (which uses `•`) got through and was stored as a national ID.
 */
const MASK_CHARACTERS = /[*•·]/;

export class InvalidIdentifierError extends Error {
  constructor(
    readonly field: string,
    readonly received: string,
  ) {
    super(
      `Kolom ${field} berisi karakter yang tidak mungkin ada pada nomor identitas: ` +
        `"${received.slice(0, 24)}". NIK, NPWP, dan nomor rekening hanya terdiri dari ` +
        'angka dan huruf.',
    );
    this.name = 'InvalidIdentifierError';
  }
}

export class MaskedValueError extends Error {
  constructor(readonly field: string) {
    super(
      `Kolom ${field} berisi nilai tersamar, bukan nilai sebenarnya. ` +
        'Nilai ini berasal dari tampilan atau ekspor tanpa izin melihat data lengkap. ' +
        'Kosongkan kolomnya, atau minta nilai aslinya dari pengguna yang berizin.',
    );
    this.name = 'MaskedValueError';
  }
}

/** True when the value is the result of masking rather than the real value. */
export function looksMasked(value: string): boolean {
  return MASK_CHARACTERS.test(value);
}

export function preparePii(
  value: string | null | undefined,
  mask: (value: string) => string,
  field = 'PII',
): { encrypted: string | null; index: string | null; masked: string | null } {
  const trimmed = value?.trim();
  if (!trimmed) return { encrypted: null, index: null, masked: null };

  /**
   * A masked value is refused HERE, not in the form that sent it.
   *
   * Principle P9: the screen hides, the server refuses. The employee grid does
   * lock its PII columns when the user has no permission to unmask — but that
   * guard applies to one screen, while the same write path is used by Excel
   * import, bulk updates, and the API directly.
   *
   * The damage is silent and permanent: a real national ID overwritten by a row
   * of asterisks, neatly encrypted, and only noticed when the first payroll run
   * needs a bank account number that no longer exists.
   */
  if (looksMasked(trimmed)) throw new MaskedValueError(field);

  /**
   * A value that cannot possibly be an identity number is refused too.
   *
   * Excel import already validates the shape of a national ID and a tax ID, but
   * the other write paths — the API directly, a bulk update from the grid — do
   * not. One field that is strict at one door and loose at another is not
   * validation; it only moves the problem to the door that is watched less.
   *
   * Two conditions, and both are needed:
   *
   *   1. Only digits and letters once separators are stripped. This catches a
   *      paste with broken encoding and a masking character that slipped past.
   *   2. It contains at least one digit. Without this, "tidak ada" becomes
   *      "TIDAKADA" and passes — and text like that is genuinely what people
   *      type when they do not have the data for a column.
   *
   * A length rule is deliberately NOT applied: bank account formats differ
   * between banks, and refusing a legitimate customer costs more than accepting
   * a number that looks unusual. Some banks also use letter prefixes, so even
   * "digits only" would be too strict.
   */
  const normalizedForCheck = normalizeIdentifier(trimmed);
  if (!/^[0-9A-Z]+$/.test(normalizedForCheck) || !/[0-9]/.test(normalizedForCheck)) {
    throw new InvalidIdentifierError(field, trimmed);
  }

  const normalized = normalizeIdentifier(trimmed);
  return {
    encrypted: encryptPii(normalized),
    index: blindIndex(normalized),
    masked: mask(normalized),
  };
}
