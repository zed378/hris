import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Enkripsi dan penyamaran data pribadi.
 *
 * Tiga kolom diperlakukan khusus: NIK KTP, NPWP, dan nomor rekening. Ketiganya
 * bersama nama dan tanggal lahir sudah cukup untuk mengajukan pinjaman atas nama
 * seseorang. Basis data yang bocor tidak boleh menyerahkannya begitu saja
 * (UU PDP No. 27/2022).
 *
 * Dua lapisan yang berbeda tujuan, dan keduanya diperlukan:
 *
 *   Enkripsi  melindungi dari dump basis data, cadangan yang salah tempat, dan
 *             replika baca yang bocor. Kuncinya tidak ada di basis data.
 *   Masking   melindungi dari mata yang tidak berhak melihat — HR magang yang
 *             membuka daftar karyawan tidak perlu melihat NIK lengkap siapa pun.
 *
 * Yang satu tidak menggantikan yang lain: enkripsi tidak menolong bila aplikasi
 * mendekripsi lalu menampilkannya kepada semua orang, dan masking tidak menolong
 * bila basis datanya sendiri dapat dibaca.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function keyFrom(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `${name} belum dipasang. Bangkitkan dengan: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} harus 32 byte dalam base64 (saat ini ${key.length} byte).`);
  }
  return key;
}

/**
 * Enkripsi AES-256-GCM.
 *
 * GCM, bukan CBC: ia terautentikasi, sehingga ciphertext yang diubah gagal saat
 * dekripsi alih-alih menghasilkan plaintext sampah yang lolos ke laporan gaji.
 *
 * Hasilnya berformat `v1.<iv>.<tag>.<ciphertext>`, seluruhnya base64url. Prefiks
 * versi ada sejak awal karena rotasi kunci selalu datang belakangan, dan tanpa
 * penanda versi, rotasi berarti menebak format setiap baris lama.
 */
export function encryptPii(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyFrom('PII_ENCRYPTION_KEY'), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptPii(encoded: string): string {
  const [version, ivPart, tagPart, dataPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Format data terenkripsi tidak dikenal');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    keyFrom('PII_ENCRYPTION_KEY'),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Indeks buta: HMAC dari nilai yang dinormalkan.
 *
 * Enkripsi yang benar bersifat acak — NIK yang sama menghasilkan ciphertext
 * berbeda setiap kali. Sifat itu yang membuatnya aman, sekaligus membuat
 * `UNIQUE(national_id)` dan "cari NIK ini" mustahil.
 *
 * Indeks buta memecahkannya: nilai deterministik yang dapat diindeks dan
 * dibandingkan, tetapi tidak dapat dibalik. Kuncinya sengaja BERBEDA dari kunci
 * enkripsi — bila keduanya sama, satu kebocoran kunci merusak dua pertahanan.
 *
 * Batasnya perlu diakui: karena deterministik, penyerang yang memegang basis
 * data dapat menguji apakah NIK tertentu ada di dalamnya, asalkan ia juga
 * memegang kunci indeks. Ia tetap tidak dapat menghitung daftar NIK.
 */
export function blindIndex(value: string): string {
  return createHmac('sha256', keyFrom('PII_INDEX_KEY'))
    .update(normalizeIdentifier(value))
    .digest('base64url');
}

/** Membuang pemisah agar "3201.1234.5678.9012" dan "3201123456789012" setara. */
export function normalizeIdentifier(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}

export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

// -----------------------------------------------------------------------------
// Penyamaran
//
// Menyisakan cukup karakter untuk memastikan "ya, ini orang yang saya maksud",
// tetapi tidak cukup untuk menyalinnya ke formulir mana pun.
// -----------------------------------------------------------------------------

/** NIK: 16 digit → `3201********9012`. */
export function maskNationalId(value: string): string {
  const digits = normalizeIdentifier(value);
  if (digits.length < 8) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
}

/** NPWP: menyisakan tiga digit terakhir. */
export function maskTaxId(value: string): string {
  const digits = normalizeIdentifier(value);
  if (digits.length < 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

/**
 * Rekening: menyisakan empat digit terakhir.
 *
 * Empat digit adalah yang lazim dicetak bank pada struk, sehingga cukup untuk
 * mencocokkan tanpa memberi tambahan apa pun kepada yang melihatnya.
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

/** Bentuk tersimpan: ciphertext berpasangan dengan versi tersamarnya. */
export interface StoredPii {
  nationalIdEncrypted: string | null;
  nationalIdMasked: string | null;
  taxIdEncrypted: string | null;
  taxIdMasked: string | null;
  bankAccountEncrypted: string | null;
  bankAccountMasked: string | null;
}

/**
 * Menyiapkan PII untuk ditampilkan, sesuai izin pembaca.
 *
 * `canUnmask` berasal dari permission `employee.pii.unmask` yang sudah diperiksa
 * gateway.
 *
 * Perhatikan bahwa **dekripsi hanya terjadi ketika izinnya ada**. Jalur tanpa
 * izin membaca kolom tersamar yang sudah tersimpan dan tidak menyentuh kunci
 * enkripsi sama sekali.
 *
 * Versi pertama fungsi ini mendekripsi lebih dulu lalu menyamarkan hasilnya —
 * terlihat setara, tetapi berarti NIK lengkap setiap karyawan pernah berada di
 * memori proses pada setiap pembukaan daftar karyawan. Dari sana ia ikut masuk
 * ke log galat, dump heap, atau jejak APM pertama yang menangkapnya.
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

/** Menyiapkan satu nilai PII untuk disimpan: ciphertext, indeks buta, dan mask. */
export function preparePii(
  value: string | null | undefined,
  mask: (value: string) => string,
): { encrypted: string | null; index: string | null; masked: string | null } {
  const trimmed = value?.trim();
  if (!trimmed) return { encrypted: null, index: null, masked: null };

  const normalized = normalizeIdentifier(trimmed);
  return {
    encrypted: encryptPii(normalized),
    index: blindIndex(normalized),
    masked: mask(normalized),
  };
}
