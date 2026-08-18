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
  normalizeIdentifier,
  preparePii,
  revealPii,
} from '../src/employee/pii.ts';

/**
 * Uji lapisan PII.
 *
 * Ini bagian yang paling mahal bila salah dan paling sunyi kegagalannya: enkripsi
 * yang rusak tidak melempar galat, ia hanya menyimpan sesuatu yang tidak dapat
 * dibaca kembali — dan biasanya baru ketahuan saat payroll pertama butuh nomor
 * rekening.
 */

describe('enkripsi', () => {
  it('bolak-balik menghasilkan nilai yang sama', () => {
    const plain = '3201123456789012';
    expect(decryptPii(encryptPii(plain))).toBe(plain);
  });

  it('nilai sama menghasilkan ciphertext berbeda', () => {
    // Sifat inilah yang membuat enkripsi aman, sekaligus yang membuat indeks buta
    // diperlukan. Bila keduanya sama, penyerang dapat menghitung siapa berbagi NIK.
    expect(encryptPii('3201123456789012')).not.toBe(encryptPii('3201123456789012'));
  });

  it('menolak ciphertext yang diubah', () => {
    // GCM bersifat terautentikasi: satu bit yang berubah harus gagal, bukan
    // menghasilkan plaintext sampah yang lolos ke slip gaji.
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
    // Data dari Excel datang dengan titik, spasi, dan tanda hubung yang bervariasi.
    // Tanpa normalisasi, NIK yang sama menghasilkan indeks berbeda dan constraint
    // unique berhenti menangkap duplikat — kegagalan yang sepenuhnya senyap.
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
    // Menyisakan "empat digit terakhir" dari nilai enam digit berarti menyerahkan
    // dua pertiganya. Data pendek yang tidak wajar biasanya salah input, dan
    // menyamarkan seluruhnya adalah kegagalan yang aman.
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
    // Inti perbaikan atas versi pertama. Dengan kunci dihapus dari lingkungan,
    // jalur tersamar harus tetap berhasil — bila ia mendekripsi diam-diam, uji
    // ini gagal dengan galat kunci.
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
