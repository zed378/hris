/**
 * Pemetaan kolom dan validasi baris untuk impor karyawan.
 *
 * Ini berkas yang menentukan apakah Gerbang A terlewati: "tiga pilot mengimpor
 * ≥100 karyawan dari berkas Excel mereka sendiri, dalam < 30 menit, tanpa
 * bantuan" (PLAN/12 Fase 2).
 *
 * Kalimat "berkas Excel mereka sendiri" yang menentukan bentuk seluruh berkas
 * ini. Berkas pelanggan tidak akan memakai judul kolom kita, tidak akan memakai
 * format tanggal kita, dan akan memuat sel kosong di tempat yang kita anggap
 * wajib. Impor yang hanya menerima format sendiri akan selalu gagal pada
 * percobaan pertama, dan pelanggan yang gagal di percobaan pertama tidak
 * mencoba yang kedua.
 */

export interface ColumnSpec {
  /** Nama field internal. */
  field: string;
  label: string;
  required: boolean;
  /**
   * Judul kolom yang dikenali otomatis, huruf kecil tanpa tanda baca.
   *
   * Daftar ini sengaja panjang dan akan terus bertambah. Setiap alias yang
   * ditambahkan adalah satu pelanggan yang tidak perlu memetakan kolom manual.
   */
  aliases: string[];
}

export const EMPLOYEE_COLUMNS: ColumnSpec[] = [
  {
    field: 'employeeNumber',
    label: 'Nomor Karyawan',
    required: true,
    aliases: ['nomor karyawan', 'no karyawan', 'nik karyawan', 'employee number', 'employee id',
              'nip', 'no induk', 'nomor induk', 'id karyawan', 'kode karyawan', 'no'],
  },
  {
    field: 'fullName',
    label: 'Nama Lengkap',
    required: true,
    aliases: ['nama lengkap', 'nama', 'full name', 'name', 'nama karyawan'],
  },
  {
    field: 'nationalId',
    label: 'NIK (KTP)',
    required: false,
    // "nik" saja ambigu: sebagian perusahaan memakainya untuk nomor induk
    // karyawan, sebagian untuk NIK KTP. Ia sengaja TIDAK ada di sini maupun di
    // employeeNumber — pengguna diminta memetakannya sendiri, karena menebak
    // salah berarti menyimpan nomor identitas nasional di kolom yang tidak
    // terenkripsi.
    aliases: ['nik ktp', 'no ktp', 'nomor ktp', 'ktp', 'national id', 'nomor induk kependudukan'],
  },
  {
    field: 'taxId',
    label: 'NPWP',
    required: false,
    aliases: ['npwp', 'no npwp', 'nomor npwp', 'tax id'],
  },
  {
    field: 'email',
    label: 'Email',
    required: false,
    aliases: ['email', 'e-mail', 'alamat email', 'email kantor'],
  },
  {
    field: 'phone',
    label: 'Telepon',
    required: false,
    aliases: ['telepon', 'no telepon', 'nomor telepon', 'hp', 'no hp', 'handphone', 'phone', 'mobile'],
  },
  {
    field: 'joinDate',
    label: 'Tanggal Masuk',
    required: true,
    aliases: ['tanggal masuk', 'tgl masuk', 'join date', 'tanggal bergabung', 'hire date',
              'tanggal mulai kerja', 'tmt'],
  },
  {
    field: 'birthDate',
    label: 'Tanggal Lahir',
    required: false,
    aliases: ['tanggal lahir', 'tgl lahir', 'birth date', 'date of birth', 'dob'],
  },
  {
    field: 'birthPlace',
    label: 'Tempat Lahir',
    required: false,
    aliases: ['tempat lahir', 'birth place', 'kota lahir'],
  },
  {
    field: 'gender',
    label: 'Jenis Kelamin',
    required: false,
    aliases: ['jenis kelamin', 'gender', 'sex', 'l/p', 'jk'],
  },
  {
    field: 'bankName',
    label: 'Nama Bank',
    required: false,
    aliases: ['bank', 'nama bank', 'bank name'],
  },
  {
    field: 'bankAccount',
    label: 'Nomor Rekening',
    required: false,
    aliases: ['nomor rekening', 'no rekening', 'rekening', 'account number', 'no rek', 'norek'],
  },
  {
    field: 'address',
    label: 'Alamat',
    required: false,
    aliases: ['alamat', 'address', 'alamat rumah', 'alamat domisili'],
  },
];

/** Menyeragamkan judul kolom agar "No. Telepon " dan "no telepon" setara. */
export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.\-_/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ColumnMapping {
  /** field internal → indeks kolom di berkas. */
  mapping: Record<string, number>;
  /** Judul kolom yang tidak dikenali. Ditampilkan agar pengguna dapat memetakannya. */
  unmapped: Array<{ index: number; header: string }>;
  missingRequired: string[];
}

/**
 * Menebak pemetaan kolom dari baris judul.
 *
 * Tebakan, bukan keputusan: hasilnya selalu ditampilkan untuk dikonfirmasi.
 * Impor yang memetakan sendiri lalu langsung menyimpan akan sesekali memasukkan
 * nomor telepon ke kolom NIK, dan kesalahan itu baru ketahuan berbulan-bulan
 * kemudian saat slip gaji pertama salah alamat.
 */
export function detectColumns(headers: string[]): ColumnMapping {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();

  for (const spec of EMPLOYEE_COLUMNS) {
    // Alias ikut dinormalkan, bukan hanya judul dari berkas.
    //
    // Tanpa ini, setiap alias yang mengandung tanda baca tidak akan pernah cocok:
    // judul "E-Mail" menjadi "e mail" setelah normalisasi, sedangkan alias
    // "e-mail" dibandingkan apa adanya. Kolomnya lalu dianggap tidak dikenali,
    // datanya tidak terbaca, dan validasinya ikut tidak berjalan — sehingga
    // alamat email yang tidak sah lolos tanpa satu pun keluhan.
    //
    // Kegagalan ini sepenuhnya senyap: impor tetap berhasil, jumlah barisnya
    // benar, dan yang hilang hanya satu kolom yang tidak diminta siapa pun.
    const aliases = spec.aliases.map(normalizeHeader);
    const index = headers.findIndex(
      (header, i) => !used.has(i) && aliases.includes(normalizeHeader(header ?? '')),
    );
    if (index >= 0) {
      mapping[spec.field] = index;
      used.add(index);
    }
  }

  const unmapped = headers
    .map((header, index) => ({ index, header: (header ?? '').trim() }))
    .filter((column) => !used.has(column.index) && column.header.length > 0);

  const missingRequired = EMPLOYEE_COLUMNS.filter(
    (spec) => spec.required && mapping[spec.field] === undefined,
  ).map((spec) => spec.label);

  return { mapping, unmapped, missingRequired };
}

export interface RowError {
  field: string;
  message: string;
}

export interface ParsedRow {
  employeeNumber: string;
  fullName: string;
  nationalId: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  joinDate: string | null;
  birthDate: string | null;
  birthPlace: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  bankName: string | null;
  bankAccount: string | null;
  address: string | null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * Mengurai tanggal dari sel Excel.
 *
 * Tiga bentuk yang harus diterima, dan ketiganya nyata:
 *
 *   - Objek Date, bila sel benar-benar berformat tanggal di Excel.
 *   - Angka serial Excel, bila sel bertipe angka. Serial 1 adalah 1900-01-01,
 *     dengan lompatan terkenal karena Excel menganggap 1900 tahun kabisat.
 *   - Teks, karena kolom tanggal yang diketik manual hampir selalu berakhir
 *     sebagai teks — dan di Indonesia bentuknya dd/mm/yyyy, bukan mm/dd/yyyy.
 *
 * Urutan hari-bulan itu yang paling berbahaya: "03/04/2024" sah dalam kedua
 * tafsir, dan menebak salah menggeser tanggal masuk seseorang tiga puluh hari
 * tanpa satu pun galat.
 */
export function parseExcelDate(value: unknown): { date: string | null; error: string | null } {
  if (value === null || value === undefined || value === '') return { date: null, error: null };

  if (value instanceof Date) {
    return { date: value.toISOString().slice(0, 10), error: null };
  }

  if (typeof value === 'number') {
    if (value < 1 || value > 60_000) {
      return { date: null, error: 'Angka tanggal di luar rentang yang wajar' };
    }
    // Serial Excel: hari sejak 1899-12-30. Offset itu sudah memperhitungkan bug
    // tahun kabisat 1900 yang sengaja dipertahankan Excel demi kompatibilitas.
    const millis = Math.round((value - 25_569) * 86_400_000);
    return { date: new Date(millis).toISOString().slice(0, 10), error: null };
  }

  const text = String(value).trim();
  if (text === '') return { date: null, error: null };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(text);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    // Bila angka pertama > 12 ia pasti hari, dan urutannya tidak ambigu.
    // Bila keduanya ≤ 12, kita tetap membaca dd/mm — konvensi Indonesia — dan
    // itu asumsi yang dinyatakan terbuka di templat, bukan tebakan diam-diam.
    return buildDate(Number(dmy[3]), month, day);
  }

  return { date: null, error: `Format tanggal tidak dikenali: "${text}"` };
}

function buildDate(year: number, month: number, day: number): { date: string | null; error: string | null } {
  if (month < 1 || month > 12) return { date: null, error: `Bulan tidak sah: ${month}` };
  if (day < 1 || day > 31) return { date: null, error: `Tanggal tidak sah: ${day}` };

  const date = new Date(Date.UTC(year, month - 1, day));
  // Menangkap 31 Februari: Date menggeser tanggal tak sah ke bulan berikutnya
  // tanpa mengeluh, sehingga hasilnya harus dicocokkan kembali.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { date: null, error: `Tanggal tidak ada dalam kalender: ${day}/${month}/${year}` };
  }
  if (year < 1900 || year > 2100) return { date: null, error: `Tahun di luar rentang: ${year}` };

  return { date: date.toISOString().slice(0, 10), error: null };
}

/**
 * Nilai yang berasal dari ekspor tersamar.
 *
 * Alurnya nyata dan mudah terjadi: seseorang tanpa izin `employee.pii.unmask`
 * mengekspor data, menyuntingnya di Excel, lalu mengimpornya kembali. Bila
 * lolos, NIK asli tertimpa menjadi "3201********9012" — kerusakan senyap yang
 * baru ketahuan saat payroll pertama membutuhkan nomor rekening.
 *
 * Pemeriksaan panjang digit sebenarnya sudah menolaknya, tetapi pesannya
 * berbunyi "NIK biasanya 16 digit angka (ditemukan 16 karakter)" — terbaca
 * seperti kontradiksi, dan tidak memberi tahu apa pun tentang cara memperbaikinya.
 */
function looksMasked(value: string): boolean {
  return value.includes('*');
}

const MASKED_MESSAGE =
  'Nilai tersamar (*) — berkas ini diekspor tanpa izin melihat data lengkap. ' +
  'Minta ekspor ulang dari pengguna yang berizin, atau kosongkan kolomnya.';

function parseGender(value: unknown): 'MALE' | 'FEMALE' | null {
  const text = cellText(value).toLowerCase();
  if (['l', 'lk', 'laki-laki', 'laki laki', 'pria', 'm', 'male'].includes(text)) return 'MALE';
  if (['p', 'pr', 'perempuan', 'wanita', 'f', 'female'].includes(text)) return 'FEMALE';
  return null;
}

/** Memvalidasi dan menormalkan satu baris. */
export function validateRow(
  cells: unknown[],
  mapping: Record<string, number>,
): { parsed: ParsedRow; errors: RowError[] } {
  const errors: RowError[] = [];
  const at = (field: string): unknown => {
    const index = mapping[field];
    return index === undefined ? undefined : cells[index];
  };

  const employeeNumber = cellText(at('employeeNumber'));
  const fullName = cellText(at('fullName'));

  if (employeeNumber === '') {
    errors.push({ field: 'employeeNumber', message: 'Nomor karyawan wajib diisi' });
  }
  if (fullName === '') {
    errors.push({ field: 'fullName', message: 'Nama lengkap wajib diisi' });
  } else if (fullName.length < 2) {
    errors.push({ field: 'fullName', message: 'Nama lengkap terlalu pendek' });
  }

  const join = parseExcelDate(at('joinDate'));
  if (join.error) errors.push({ field: 'joinDate', message: join.error });
  else if (join.date === null) {
    errors.push({ field: 'joinDate', message: 'Tanggal masuk wajib diisi' });
  }

  const birth = parseExcelDate(at('birthDate'));
  if (birth.error) errors.push({ field: 'birthDate', message: birth.error });

  if (join.date && birth.date && birth.date >= join.date) {
    errors.push({ field: 'birthDate', message: 'Tanggal lahir harus sebelum tanggal masuk' });
  }

  const nationalId = cellText(at('nationalId'));
  if (nationalId !== '') {
    const digits = nationalId.replace(/[\s.\-/]/g, '');
    if (looksMasked(nationalId)) {
      errors.push({ field: 'nationalId', message: MASKED_MESSAGE });
    } else
    // Peringatan, bukan penolakan — NIK 16 digit adalah aturan, tetapi berkas
    // lama berisi data warga negara asing dan karyawan lama yang tidak
    // memenuhinya. Menolaknya berarti menolak impor seluruh berkas.
    if (!/^\d{16}$/.test(digits)) {
      errors.push({
        field: 'nationalId',
        message: `NIK biasanya 16 digit angka (ditemukan ${digits.length} karakter). Periksa kembali.`,
      });
    }
  }

  const email = cellText(at('email'));
  if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: 'email', message: `Email tidak sah: "${email}"` });
  }

  const taxId = cellText(at('taxId'));
  if (taxId !== '' && looksMasked(taxId)) {
    errors.push({ field: 'taxId', message: MASKED_MESSAGE });
  }

  const bankAccount = cellText(at('bankAccount'));
  if (bankAccount !== '' && looksMasked(bankAccount)) {
    errors.push({ field: 'bankAccount', message: MASKED_MESSAGE });
  }

  return {
    parsed: {
      employeeNumber,
      fullName,
      nationalId: nationalId || null,
      taxId: taxId || null,
      email: email || null,
      phone: cellText(at('phone')) || null,
      joinDate: join.date,
      birthDate: birth.date,
      birthPlace: cellText(at('birthPlace')) || null,
      gender: parseGender(at('gender')),
      bankName: cellText(at('bankName')) || null,
      bankAccount: bankAccount || null,
      address: cellText(at('address')) || null,
    },
    errors,
  };
}
