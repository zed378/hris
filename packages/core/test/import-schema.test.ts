import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_COLUMNS,
  detectColumns,
  normalizeHeader,
  parseExcelDate,
  validateRow,
} from '../src/employee/import-schema.ts';

/**
 * Uji pemetaan kolom dan validasi baris impor.
 *
 * Yang diuji di sini adalah satu-satunya hal yang menentukan apakah Gerbang A
 * terlewati: apakah berkas Excel milik pelanggan — bukan berkas kita — dapat
 * dibaca tanpa bantuan.
 */

describe('deteksi kolom', () => {
  it('mengenali judul berbahasa Indonesia yang lazim', () => {
    const { mapping, missingRequired } = detectColumns([
      'No. Induk', 'Nama', 'NIK KTP', 'TMT', 'Tgl Lahir', 'JK', 'No. Rek',
    ]);

    expect(missingRequired).toEqual([]);
    expect(mapping['employeeNumber']).toBe(0);
    expect(mapping['fullName']).toBe(1);
    expect(mapping['nationalId']).toBe(2);
    expect(mapping['joinDate']).toBe(3);
    expect(mapping['birthDate']).toBe(4);
    expect(mapping['gender']).toBe(5);
    expect(mapping['bankAccount']).toBe(6);
  });

  it('mengenali alias yang mengandung tanda baca', () => {
    // Regresi. Alias seperti "e-mail" dulu tidak pernah cocok, karena judul dari
    // berkas dinormalkan menjadi "e mail" sementara aliasnya dibandingkan apa
    // adanya. Akibatnya kolom email diam-diam tidak terbaca, dan validasinya
    // ikut tidak berjalan — impor tetap "berhasil" dengan satu kolom hilang.
    const { mapping } = detectColumns(['No. Induk', 'Nama', 'E-Mail', 'TMT']);
    expect(mapping['email']).toBe(2);
  });

  it('melaporkan kolom wajib yang tidak ada', () => {
    const { missingRequired } = detectColumns(['Nama', 'Alamat']);
    expect(missingRequired).toContain('Nomor Karyawan');
    expect(missingRequired).toContain('Tanggal Masuk');
  });

  it('melaporkan judul yang tidak dikenali agar dapat dipetakan manual', () => {
    const { unmapped } = detectColumns(['No. Induk', 'Nama', 'TMT', 'Golongan Darah']);
    expect(unmapped).toEqual([{ index: 3, header: 'Golongan Darah' }]);
  });

  it('tidak memetakan dua field ke kolom yang sama', () => {
    const { mapping } = detectColumns(['Nama', 'Nama', 'No. Induk', 'TMT']);
    expect(mapping['fullName']).toBe(0);
    expect(Object.values(mapping).filter((i) => i === 0)).toHaveLength(1);
  });

  it('"NIK" sendirian sengaja tidak dipetakan otomatis', () => {
    // Ambigu: sebagian perusahaan memakainya untuk nomor induk karyawan,
    // sebagian untuk NIK KTP. Menebak salah berarti menyimpan nomor identitas
    // nasional di kolom yang tidak terenkripsi.
    const { mapping, unmapped } = detectColumns(['NIK', 'Nama', 'TMT', 'No. Induk']);
    expect(mapping['nationalId']).toBeUndefined();
    expect(unmapped.map((c) => c.header)).toContain('NIK');
  });

  it('tidak ada dua kolom yang memperebutkan judul yang sama', () => {
    // Invarian yang masih berguna setelah alias dinormalkan otomatis.
    //
    // Bila dua field mengklaim alias yang sama setelah normalisasi, yang menang
    // ditentukan urutan deklarasi di EMPLOYEE_COLUMNS — dan itu bukan keputusan
    // yang sedang diambil siapa pun secara sadar. Menambahkan "no rek" ke dua
    // kolom, misalnya, akan membuat nomor rekening masuk ke kolom yang salah
    // pada sebagian berkas dan benar pada sebagian lain.
    const owner = new Map<string, string>();
    const collisions: string[] = [];

    for (const spec of EMPLOYEE_COLUMNS) {
      for (const alias of spec.aliases) {
        const key = normalizeHeader(alias);
        const existing = owner.get(key);
        if (existing && existing !== spec.field) {
          collisions.push(`"${key}" diklaim ${existing} dan ${spec.field}`);
        }
        owner.set(key, spec.field);
      }
    }

    expect(collisions).toEqual([]);
  });
});

describe('penguraian tanggal', () => {
  it('membaca dd/mm/yyyy sebagai konvensi Indonesia', () => {
    expect(parseExcelDate('01/03/2024').date).toBe('2024-03-01');
    expect(parseExcelDate('15-08-1995').date).toBe('1995-08-15');
  });

  it('membaca ISO', () => {
    expect(parseExcelDate('2024-03-01').date).toBe('2024-03-01');
  });

  it('membaca objek Date dari sel bertipe tanggal', () => {
    expect(parseExcelDate(new Date(Date.UTC(2024, 2, 1))).date).toBe('2024-03-01');
  });

  it('membaca angka serial Excel', () => {
    // 45352 = 2024-03-01 pada penanggalan serial Excel.
    expect(parseExcelDate(45352).date).toBe('2024-03-01');
  });

  it('menolak tanggal yang tidak ada dalam kalender', () => {
    expect(parseExcelDate('31/02/2024').error).toMatch(/tidak ada dalam kalender/i);
    expect(parseExcelDate('32/13/2024').error).toBeTruthy();
  });

  it('sel kosong bukan galat', () => {
    expect(parseExcelDate(null)).toEqual({ date: null, error: null });
    expect(parseExcelDate('')).toEqual({ date: null, error: null });
  });

  it('teks yang bukan tanggal dilaporkan apa adanya', () => {
    expect(parseExcelDate('belum ada').error).toContain('belum ada');
  });
});

describe('validasi baris', () => {
  const mapping = { employeeNumber: 0, fullName: 1, joinDate: 2, email: 3, nationalId: 4 };

  it('baris lengkap tidak menghasilkan galat', () => {
    const { errors, parsed } = validateRow(
      ['K-001', 'Siti Rahayu', '01/03/2024', 'siti@pt.co.id', '3201123456789012'],
      mapping,
    );
    expect(errors).toEqual([]);
    expect(parsed.employeeNumber).toBe('K-001');
    expect(parsed.joinDate).toBe('2024-03-01');
  });

  it('melaporkan SELURUH galat satu baris sekaligus', () => {
    // Bukan hanya yang pertama. Pengguna memperbaiki berkasnya di Excel, dan
    // melaporkan satu galat per unggahan berarti ia harus mengunggah berkali-kali
    // untuk baris yang sama.
    const { errors } = validateRow(['', '', 'bukan tanggal', 'bukan email', ''], mapping);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('employeeNumber');
    expect(fields).toContain('fullName');
    expect(fields).toContain('joinDate');
    expect(fields).toContain('email');
  });

  it('NIK bukan 16 digit ditandai, bukan ditolak diam-diam', () => {
    const { errors, parsed } = validateRow(
      ['K-001', 'Siti', '01/03/2024', '', '32011234'],
      mapping,
    );
    expect(errors.some((e) => e.field === 'nationalId')).toBe(true);
    // Nilainya tetap diurai supaya pengguna melihat apa yang ia ketik.
    expect(parsed.nationalId).toBe('32011234');
  });

  it('menolak nilai tersamar hasil ekspor tanpa izin', () => {
    // Alur nyata: pengguna tanpa `employee.pii.unmask` mengekspor data,
    // menyuntingnya di Excel, lalu mengimpornya kembali. Bila lolos, NIK asli
    // tertimpa menjadi "3201********9012" — kerusakan senyap yang baru ketahuan
    // saat payroll pertama membutuhkan nomor rekening.
    const { errors } = validateRow(
      ['K-001', 'Siti', '01/03/2024', '', '3201********9012'],
      mapping,
    );

    const nik = errors.find((e) => e.field === 'nationalId');
    expect(nik).toBeDefined();
    // Pesannya harus menjelaskan penyebab dan jalan keluarnya. Aturan panjang
    // digit sebenarnya sudah menolak nilai ini, tetapi pesannya berbunyi
    // "16 digit angka (ditemukan 16 karakter)" — terbaca seperti kontradiksi.
    expect(nik!.message).toMatch(/tersamar/i);
    expect(nik!.message).toMatch(/kosongkan|ekspor ulang/i);
  });

  it('nilai tersamar terdeteksi pada NPWP dan rekening juga', () => {
    const wide = { ...mapping, taxId: 5, bankAccount: 6 };
    const { errors } = validateRow(
      ['K-001', 'Siti', '01/03/2024', '', '', '************000', '******7890'],
      wide,
    );

    expect(errors.some((e) => e.field === 'taxId')).toBe(true);
    expect(errors.some((e) => e.field === 'bankAccount')).toBe(true);
  });

  it('tanggal lahir setelah tanggal masuk ditolak', () => {
    const withBirth = { ...mapping, birthDate: 5 };
    const { errors } = validateRow(
      ['K-001', 'Siti', '01/01/2020', '', '', '01/01/2021'],
      withBirth,
    );
    expect(errors.some((e) => e.field === 'birthDate')).toBe(true);
  });

  it('membaca jenis kelamin dalam berbagai bentuk', () => {
    const g = { ...mapping, gender: 5 };
    const read = (value: string) =>
      validateRow(['K-001', 'Siti', '01/03/2024', '', '', value], g).parsed.gender;

    expect(read('L')).toBe('MALE');
    expect(read('Laki-laki')).toBe('MALE');
    expect(read('PRIA')).toBe('MALE');
    expect(read('P')).toBe('FEMALE');
    expect(read('Perempuan')).toBe('FEMALE');
    expect(read('tidak jelas')).toBeNull();
  });
});
