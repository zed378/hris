import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

const { prepareRowPii, buildRawForStorage } = await import('../src/employee/import.ts');
const { EMPLOYEE_COLUMNS } = await import('../src/employee/import-schema.ts');
import type { ParsedRow, RowError } from '../src/employee/import-schema.ts';

/**
 * PII tidak boleh berada sebagai teks biasa di staging impor.
 *
 * Bug yang ditutup uji ini membatalkan seluruh kerja enkripsi PII bagi jalur
 * onboarding yang paling banyak dipakai. `import_rows` menyimpan isi berkas apa
 * adanya, dan berkas impor karyawan memuat kolom NIK, NPWP, dan Nomor Rekening.
 * Satu impor 500 karyawan meninggalkan 500 NIK sebagai teks biasa di dalam JSON
 * — di basis data yang sama yang mengenkripsi kolom NIK di tabel sebelahnya
 * dengan AES-256-GCM.
 */

const NIK = '3174012501900007';
const NPWP = '091234567890000';
const REK = '1234567890';

function baris(over: Partial<ParsedRow> = {}): ParsedRow {
  return {
    employeeNumber: 'E-1',
    fullName: 'Uji',
    nationalId: NIK,
    taxId: NPWP,
    email: null,
    phone: null,
    joinDate: '2024-01-02',
    birthDate: null,
    birthPlace: null,
    gender: null,
    bankName: null,
    bankAccount: REK,
    address: null,
    ...over,
  };
}

describe('parsed', () => {
  it('menyimpan PII terenkripsi, ber-indeks, dan bertopeng — bukan teks biasa', () => {
    const errors: RowError[] = [];
    const stored = prepareRowPii(baris(), errors);

    expect(errors).toEqual([]);
    for (const field of ['nationalId', 'taxId', 'bankAccount'] as const) {
      expect(stored[field].encrypted, field).toBeTruthy();
      expect(stored[field].masked, field).toBeTruthy();
    }

    const json = JSON.stringify(stored);
    for (const nilai of [NIK, NPWP, REK]) {
      expect(json.includes(nilai), `${nilai} bocor ke parsed`).toBe(false);
    }
  });

  it('menjadikan nilai yang ditolak sebagai galat baris, bukan kegagalan impor', () => {
    // Satu sel berisi "tidak ada" tidak boleh menggagalkan 999 baris lainnya.
    const errors: RowError[] = [];
    const stored = prepareRowPii(baris({ nationalId: 'tidak ada' }), errors);

    expect(errors.map((e) => e.field)).toContain('nationalId');
    expect(stored.nationalId.encrypted).toBeNull();
    // Baris lainnya tetap tersiapkan.
    expect(stored.taxId.encrypted).toBeTruthy();
  });
});

describe('raw', () => {
  const mapping = { employeeNumber: 2, fullName: 1, nationalId: 0, taxId: 4, bankAccount: 5 };
  const cells = [NIK, 'Uji Rahasia', 'E-1', '2024-01-02', NPWP, REK];

  it('menyimpan kolom PII sebagai bentuk bertopeng', () => {
    const stored = prepareRowPii(baris(), []);
    const raw = buildRawForStorage(cells, mapping, stored);

    expect(raw['nationalId']).toBe(stored.nationalId.masked);
    expect(raw['fullName']).toBe('Uji Rahasia');

    const json = JSON.stringify(raw);
    for (const nilai of [NIK, NPWP, REK]) {
      expect(json.includes(nilai), `${nilai} bocor ke raw`).toBe(false);
    }
  });

  it('membuang kolom yang TIDAK dikenali sepenuhnya', () => {
    // Inilah lubang yang ditemukan uji e2e, dan bentuknya halus.
    //
    // "NIK" saja SENGAJA bukan alias yang dikenali — daftar aliasnya
    // mengecualikannya karena sebagian perusahaan memakainya untuk nomor induk
    // karyawan. Kehati-hatian itu benar. Tetapi versi pertama menyimpan seluruh
    // sel apa adanya lalu menutupi kolom PII yang DIKENALI — sehingga kolom
    // yang justru tidak dikenali tersimpan utuh, dan yang dihindari terjadi
    // lewat pintu lain.
    //
    // Juga berlaku untuk kolom bawaan tenant sendiri: "Nama Ibu Kandung",
    // "Golongan Darah", "Nomor BPJS".
    const stored = prepareRowPii(baris({ nationalId: null }), []);
    const raw = buildRawForStorage(
      [...cells, 'Siti Rahayu'],
      { fullName: 1, employeeNumber: 2 }, // NIK dan ibu kandung tidak dipetakan
      stored,
    );

    expect(JSON.stringify(raw).includes(NIK)).toBe(false);
    expect(JSON.stringify(raw).includes('Siti Rahayu')).toBe(false);
    expect(Object.keys(raw).sort()).toEqual(['employeeNumber', 'fullName']);
  });

  it('setiap kolom PII pada skema impor ikut ditutup', () => {
    // Menjaga daftar `PII_FIELDS` tetap sejalan dengan skema impor. Kolom PII
    // baru yang ditambahkan tanpa mendaftarkannya akan tersimpan sebagai teks
    // biasa, dan tidak ada satu pun galat yang muncul.
    const piiFields = ['nationalId', 'taxId', 'bankAccount'];
    for (const field of piiFields) {
      expect(
        EMPLOYEE_COLUMNS.some((c) => c.field === field),
        `${field} tidak ada di skema impor`,
      ).toBe(true);
    }

    const stored = prepareRowPii(baris(), []);
    const semua = Object.fromEntries(EMPLOYEE_COLUMNS.map((c, i) => [c.field, i]));
    const isi = EMPLOYEE_COLUMNS.map((c) =>
      c.field === 'nationalId' ? NIK : c.field === 'taxId' ? NPWP : c.field === 'bankAccount' ? REK : 'x',
    );
    const raw = buildRawForStorage(isi, semua, stored);
    const json = JSON.stringify(raw);
    for (const nilai of [NIK, NPWP, REK]) {
      expect(json.includes(nilai), `${nilai} bocor`).toBe(false);
    }
  });
});
