import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import {
  blindIndex,
  decryptPii,
  encryptPii,
  maskBankAccount,
  maskNationalId,
  maskTaxId,
  MaskedValueError,
  InvalidIdentifierError,
  normalizeIdentifier,
  preparePii,
  revealPii,
} from '../src/employee/pii.ts';

/**
 * Tests for the PII layer.
 *
 * This is the part most expensive to get wrong and quietest when it fails:
 * broken encryption throws no error, it merely stores something that cannot be
 * read back — and that is usually discovered when the first payroll run needs a
 * bank account number.
 */

describe('enkripsi', () => {
  it('bolak-balik menghasilkan nilai yang sama', () => {
    const plain = '3201123456789012';
    expect(decryptPii(encryptPii(plain))).toBe(plain);
  });

  it('nilai sama menghasilkan ciphertext berbeda', () => {
    // This property is what makes encryption safe, and also what makes a blind
    // index necessary. If the two matched, an attacker could work out who shares a national ID.
    expect(encryptPii('3201123456789012')).not.toBe(encryptPii('3201123456789012'));
  });

  it('menolak ciphertext yang diubah', () => {
    // GCM is authenticated: one changed bit has to fail rather than produce
    // garbage plaintext that reaches a payslip.
    const encoded = encryptPii('3201123456789012');
    const parts = encoded.split('.');
    const tampered = Buffer.from(parts[3]!, 'base64url');
    tampered[0] ^= 0xff;
    parts[3] = tampered.toString('base64url');

    expect(() => decryptPii(parts.join('.'))).toThrow();
  });

  it('menolak format yang tidak dikenal', () => {
    expect(() => decryptPii('bukan-format-yang-benar')).toThrow(/tidak dikenal/i);
  });
});

describe('indeks buta', () => {
  it('deterministik', () => {
    expect(blindIndex('3201123456789012')).toBe(blindIndex('3201123456789012'));
  });

  it('mengabaikan pemisah', () => {
    // Data from Excel arrives with varying dots, spaces, and hyphens. Without
    // normalisation the same national ID produces different indexes and the
    // unique constraint stops catching duplicates — an entirely silent failure.
    expect(blindIndex('3201.1234.5678.9012')).toBe(blindIndex('3201123456789012'));
    expect(blindIndex('3201 1234 5678 9012')).toBe(blindIndex('3201123456789012'));
    expect(blindIndex('3201-1234-5678-9012')).toBe(blindIndex('3201123456789012'));
  });

  it('nilai berbeda menghasilkan indeks berbeda', () => {
    expect(blindIndex('3201123456789012')).not.toBe(blindIndex('3201123456789013'));
  });

  it('tidak sama dengan nilai aslinya', () => {
    const value = '3201123456789012';
    expect(blindIndex(value)).not.toContain(value);
  });
});

describe('penyamaran', () => {
  it('NIK menyisakan empat digit awal dan akhir', () => {
    expect(maskNationalId('3201123456789012')).toBe('3201********9012');
  });

  it('NPWP menyisakan tiga digit akhir', () => {
    expect(maskTaxId('09.254.294.3-407.000')).toBe('************000');
  });

  it('rekening menyisakan empat digit akhir', () => {
    expect(maskBankAccount('1234567890')).toBe('******7890');
  });

  it('nilai pendek disamarkan seluruhnya', () => {
    // Leaving the "last four digits" of a six-digit value hands over two thirds
    // of it. Unusually short data is usually a mistyped entry, and masking all of
    // it is the safe failure.
    expect(maskNationalId('12345')).toBe('*****');
    expect(maskBankAccount('1234')).toBe('****');
  });

  it('normalisasi menaikkan huruf agar NPWP berhuruf konsisten', () => {
    expect(normalizeIdentifier('ab.12-34 56')).toBe('AB123456');
  });
});

describe('revealPii', () => {
  const stored = (() => {
    const nationalId = preparePii('3201123456789012', maskNationalId);
    const taxId = preparePii('09.254.294.3-407.000', maskTaxId);
    const bankAccount = preparePii('1234567890', maskBankAccount);
    return {
      nationalIdEncrypted: nationalId.encrypted,
      nationalIdMasked: nationalId.masked,
      taxIdEncrypted: taxId.encrypted,
      taxIdMasked: taxId.masked,
      bankAccountEncrypted: bankAccount.encrypted,
      bankAccountMasked: bankAccount.masked,
    };
  })();

  it('tanpa izin: mengembalikan nilai tersamar', () => {
    expect(revealPii(stored, false)).toEqual({
      nationalId: '3201********9012',
      taxId: '************000',
      bankAccount: '******7890',
    });
  });

  it('dengan izin: mengembalikan nilai lengkap yang dinormalkan', () => {
    expect(revealPii(stored, true)).toEqual({
      nationalId: '3201123456789012',
      taxId: '092542943407000',
      bankAccount: '1234567890',
    });
  });

  it('tanpa izin, kunci enkripsi tidak pernah disentuh', () => {
    // The heart of the fix over the first version. With the key removed from the
    // environment, the masked path still has to succeed — if it decrypted
    // silently, this test would fail with a key error.
    const saved = process.env['PII_ENCRYPTION_KEY'];
    delete process.env['PII_ENCRYPTION_KEY'];
    try {
      expect(revealPii(stored, false).nationalId).toBe('3201********9012');
    } finally {
      process.env['PII_ENCRYPTION_KEY'] = saved;
    }
  });

  it('kolom kosong tetap null di kedua jalur', () => {
    const empty = {
      nationalIdEncrypted: null,
      nationalIdMasked: null,
      taxIdEncrypted: null,
      taxIdMasked: null,
      bankAccountEncrypted: null,
      bankAccountMasked: null,
    };
    expect(revealPii(empty, false)).toEqual({ nationalId: null, taxId: null, bankAccount: null });
    expect(revealPii(empty, true)).toEqual({ nationalId: null, taxId: null, bankAccount: null });
  });
});

describe('preparePii', () => {
  it('nilai kosong menghasilkan tiga null', () => {
    expect(preparePii('   ', maskNationalId)).toEqual({
      encrypted: null,
      index: null,
      masked: null,
    });
    expect(preparePii(null, maskNationalId).encrypted).toBeNull();
    expect(preparePii(undefined, maskNationalId).encrypted).toBeNull();
  });

  it('menyimpan bentuk yang dinormalkan, bukan yang diketik', () => {
    const prepared = preparePii('3201.1234.5678.9012', maskNationalId);
    expect(decryptPii(prepared.encrypted!)).toBe('3201123456789012');
    expect(prepared.masked).toBe('3201********9012');
  });
});

/**
 * The masked value guard, at the write boundary.
 *
 * The bug this test closes was found through an end-to-end bulk update: a value
 * of `••••••••1234` copied off the screen was accepted and stored as a national
 * ID. The grid does lock its column — but that lock applies to one screen, while
 * the same write path is used by Excel import, bulk updates, and the API
 * directly (principle P9: the screen hides, the server refuses).
 *
 * The damage is silent and permanent: the real national ID overwritten by a row
 * of marks, neatly encrypted, and only discovered when the first payroll run
 * needs a bank account number.
 */
describe('penolakan nilai tersamar', () => {
  it('menolak samaran bintang dari ekspor Excel', () => {
    expect(() => preparePii('3201********9012', maskNationalId, 'NIK')).toThrow(MaskedValueError);
  });

  it('menolak samaran bulatan dari tampilan layar', () => {
    // This is the character that got through the first version of this guard,
    // because its check only recognised the asterisk.
    expect(() => preparePii('••••••••1234', maskBankAccount, 'rekening')).toThrow(
      MaskedValueError,
  InvalidIdentifierError,
    );
  });

  it('menyebut kolomnya dalam pesan', () => {
    // A message that does not name the offending column cannot be acted on for a
    // row holding three PII columns.
    expect(() => preparePii('****1234', maskTaxId, 'NPWP')).toThrow(/NPWP/);
  });

  it('menerima nilai sebenarnya', () => {
    const hasil = preparePii('3201234567899012', maskNationalId, 'NIK');
    expect(hasil.encrypted).not.toBeNull();
    expect(hasil.masked).toContain('*');
  });

  it('menerima kolom kosong tanpa mengeluh', () => {
    // Clearing a column is a legitimate way of not filling it in, and the error
    // message itself suggests exactly that.
    expect(preparePii('', maskNationalId, 'NIK').encrypted).toBeNull();
    expect(preparePii(null, maskNationalId, 'NIK').encrypted).toBeNull();
  });
});

describe('penolakan nilai yang mustahil menjadi nomor identitas', () => {
  it('menolak hasil salin-tempel yang rusak encoding-nya', () => {
    // Found through e2e: a shell mis-encoding the masking character sent a run of
    // replacement characters, and that value was stored as a national ID without
    // one objection.
    expect(() => preparePii('\uFFFD\uFFFD\uFFFD\uFFFD1234', maskNationalId, 'NIK')).toThrow(
      InvalidIdentifierError,
    );
  });

  it('menolak teks biasa yang tidak sengaja tertempel di kolom PII', () => {
    expect(() => preparePii('tidak ada', maskNationalId, 'NIK')).toThrow(InvalidIdentifierError);
    expect(() => preparePii('n/a (belum lapor)', maskTaxId, 'NPWP')).toThrow(
      InvalidIdentifierError,
    );
  });

  it('tetap menerima pemisah yang lazim diketik orang', () => {
    // A tax ID is almost always written with dots and dashes. Refusing that would
    // make people retype the whole column, and retyping is where the real
    // mistakes come from.
    expect(() => preparePii('09.254.294.3-407.000', maskTaxId, 'NPWP')).not.toThrow();
    expect(() => preparePii('3201 2345 6789 9012', maskNationalId, 'NIK')).not.toThrow();
  });

  it('menerima nomor rekening bercampur huruf', () => {
    // Some banks use a letter prefix. A length rule or a digits-only rule would
    // refuse a legitimate customer, and that costs more than accepting one that
    // looks odd.
    expect(() => preparePii('BCA1234567890', maskBankAccount, 'rekening')).not.toThrow();
  });
});
