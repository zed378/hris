import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  blindIndex,
  blindIndexCandidates,
  decryptPii,
  encryptPii,
  isEncryptedWithPrimaryKey,
  isIndexedWithPrimaryKey,
  UndecryptableError,
} from '../src/employee/pii.ts';

/**
 * Key rotation, which until now existed only as a sentence in a document saying
 * it was possible.
 *
 * These tests matter more than most in this repository for one reason: the code
 * they cover is the only code in the system capable of destroying data that
 * exists nowhere else. A national ID re-encrypted under a key nobody has is not
 * recoverable from a backup taken after the run, and the loss surfaces months
 * later when payroll needs a bank account number.
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const INDEX_A = randomBytes(32).toString('base64');
const INDEX_B = randomBytes(32).toString('base64');

const original = { ...process.env };

beforeEach(() => {
  process.env['PII_ENCRYPTION_KEY'] = KEY_A;
  process.env['PII_INDEX_KEY'] = INDEX_A;
  delete process.env['PII_ENCRYPTION_KEYS_OLD'];
  delete process.env['PII_INDEX_KEYS_OLD'];
});

afterEach(() => {
  process.env = { ...original };
});

describe('the encryption key ring', () => {
  it('reads a value written by an old key once that key is on the ring', () => {
    const ciphertext = encryptPii('3201123456789012');

    // The rotation itself: a new primary, the old one demoted to read-only.
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = KEY_A;

    expect(decryptPii(ciphertext)).toBe('3201123456789012');
  });

  /**
   * The step that ends a rotation, and the reason it must fail loudly.
   *
   * A fallback with no end date is how a "rotated" system keeps a decade-old key
   * alive in production — and nobody finds out until that key is the one that
   * leaks. Removing the old key has to break the rows that were never converted,
   * because that breakage is the only evidence the job did not finish.
   */
  it('fails loudly once the old key is removed, rather than returning nothing', () => {
    const ciphertext = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;

    expect(() => decryptPii(ciphertext)).toThrow(UndecryptableError);
  });

  it('names how many keys were tried, so the ring itself can be diagnosed', () => {
    const ciphertext = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = `${randomBytes(32).toString('base64')}`;

    try {
      decryptPii(ciphertext);
      expect.unreachable('should not decrypt');
    } catch (error) {
      expect(error).toBeInstanceOf(UndecryptableError);
      expect((error as UndecryptableError).keysTried).toBe(2);
    }
  });

  it('accepts a ring written with spaces and trailing commas', () => {
    const ciphertext = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = ` ${KEY_A} , `;

    expect(decryptPii(ciphertext)).toBe('3201123456789012');
  });

  /**
   * The property that makes trying keys in turn legal at all.
   *
   * GCM authenticates, so the wrong key produces a failed tag rather than
   * plausible plaintext. Under CBC this same loop would be a padding oracle and
   * would occasionally return garbage that looks like a national ID.
   */
  it('never returns plaintext from the wrong key', () => {
    const ciphertext = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      process.env['PII_ENCRYPTION_KEYS_OLD'] = randomBytes(32).toString('base64');
      expect(() => decryptPii(ciphertext)).toThrow(UndecryptableError);
    }
  });
});

describe('isEncryptedWithPrimaryKey', () => {
  /**
   * This predicate IS the rotation job's progress state. There is no marker
   * column and no resume cursor — each row answers for itself — so a wrong
   * answer here does not cause a slow rotation, it causes a rotation that
   * reports success while skipping rows.
   */
  it('is true for a value the current key wrote', () => {
    expect(isEncryptedWithPrimaryKey(encryptPii('3201123456789012'))).toBe(true);
  });

  it('is false for a value an old key wrote', () => {
    const ciphertext = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = KEY_A;

    expect(isEncryptedWithPrimaryKey(ciphertext)).toBe(false);
  });

  it('is false for malformed input rather than throwing', () => {
    for (const bad of ['', 'v1', 'v2.a.b.c', 'not-encrypted-at-all', 'v1..b.c']) {
      expect(isEncryptedWithPrimaryKey(bad), bad).toBe(false);
    }
  });

  it('turns true after a re-encryption, which is what ends the job', () => {
    const before = encryptPii('3201123456789012');
    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = KEY_A;

    expect(isEncryptedWithPrimaryKey(before)).toBe(false);
    const after = encryptPii(decryptPii(before));
    expect(isEncryptedWithPrimaryKey(after)).toBe(true);
    expect(decryptPii(after)).toBe('3201123456789012');
  });
});

describe('the blind index ring', () => {
  /**
   * The failure this prevents is not "lookup returns nothing" — it is the
   * importer reading "not found" as permission to create, and producing a second
   * employee record for a person who is already in the system.
   */
  it('offers the old index as a candidate during a rotation', () => {
    const stored = blindIndex('3201123456789012');

    process.env['PII_INDEX_KEY'] = INDEX_B;
    process.env['PII_INDEX_KEYS_OLD'] = INDEX_A;

    const candidates = blindIndexCandidates('3201123456789012');
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(stored);
    // Newest first: the value a fresh write would store.
    expect(candidates[0]).toBe(blindIndex('3201123456789012'));
    expect(candidates[0]).not.toBe(stored);
  });

  it('normalises separators the same way the writer does', () => {
    expect(blindIndexCandidates('3201.1234.5678.9012')[0]).toBe(blindIndex('3201123456789012'));
  });

  it('yields exactly one candidate when nothing is being rotated', () => {
    expect(blindIndexCandidates('3201123456789012')).toEqual([blindIndex('3201123456789012')]);
  });

  it('recognises an index that still belongs to the previous key', () => {
    const stored = blindIndex('3201123456789012');
    process.env['PII_INDEX_KEY'] = INDEX_B;
    process.env['PII_INDEX_KEYS_OLD'] = INDEX_A;

    expect(isIndexedWithPrimaryKey('3201123456789012', stored)).toBe(false);
    expect(isIndexedWithPrimaryKey('3201123456789012', blindIndex('3201123456789012'))).toBe(true);
  });
});

describe('rotating both keys at once', () => {
  /**
   * The realistic incident: a suspected leak, where nobody can say which of the
   * two keys was exposed, so both are replaced in one operation.
   */
  it('converts a row end to end without changing what it means', () => {
    const nationalId = '3201123456789012';
    const storedCipher = encryptPii(nationalId);
    const storedIndex = blindIndex(nationalId);

    process.env['PII_ENCRYPTION_KEY'] = KEY_B;
    process.env['PII_ENCRYPTION_KEYS_OLD'] = KEY_A;
    process.env['PII_INDEX_KEY'] = INDEX_B;
    process.env['PII_INDEX_KEYS_OLD'] = INDEX_A;

    // The row is still findable while it waits its turn.
    expect(blindIndexCandidates(nationalId)).toContain(storedIndex);

    const plain = decryptPii(storedCipher);
    const rewrittenCipher = encryptPii(plain);
    const rewrittenIndex = blindIndex(plain);

    expect(plain).toBe(nationalId);
    expect(decryptPii(rewrittenCipher)).toBe(nationalId);
    expect(isEncryptedWithPrimaryKey(rewrittenCipher)).toBe(true);
    expect(isIndexedWithPrimaryKey(nationalId, rewrittenIndex)).toBe(true);

    // And after the old keys are withdrawn, the converted row still reads.
    delete process.env['PII_ENCRYPTION_KEYS_OLD'];
    delete process.env['PII_INDEX_KEYS_OLD'];
    expect(decryptPii(rewrittenCipher)).toBe(nationalId);
    expect(blindIndexCandidates(nationalId)).toEqual([rewrittenIndex]);
  });
});
