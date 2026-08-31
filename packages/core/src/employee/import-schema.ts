import { looksMasked } from './pii.ts';

/**
 * Column mapping and row validation for the employee import.
 *
 * This is the file that decides whether Gate A is passed: "three pilots import
 * ≥100 employees from their own Excel files, in under 30 minutes, unaided"
 * (PLAN/12 Phase 2).
 *
 * The phrase "their own Excel files" shapes this whole file. A customer's file
 * will not use our column headers, will not use our date format, and will have
 * empty cells where we consider a value mandatory. An import that only accepts
 * its own format will always fail on the first attempt, and a customer who fails
 * on the first attempt does not try a second.
 */

export interface ColumnSpec {
  /** The internal field name. */
  field: string;
  label: string;
  required: boolean;
  /**
   * Column headers recognised automatically, lower case without punctuation.
   *
   * This list is deliberately long and will keep growing. Every alias added is
   * one customer who does not have to map a column by hand.
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
    // "nik" alone is ambiguous: some companies use it for the employee number,
    // others for the national ID card number. It is deliberately NOT here and
    // not in employeeNumber either — the user is asked to map it themselves,
    // because guessing wrong means storing a national identity number in an
    // unencrypted column.
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

/** Normalises a column header so "No. Telepon " and "no telepon" match. */
export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.\-_/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ColumnMapping {
  /** internal field → column index in the file. */
  mapping: Record<string, number>;
  /** Unrecognised column headers. Shown so the user can map them. */
  unmapped: Array<{ index: number; header: string }>;
  missingRequired: string[];
}

/**
 * Guesses the column mapping from the header row.
 *
 * A guess, not a decision: its result is always shown for confirmation. An
 * import that maps itself and saves straight away will occasionally put a phone
 * number into the national ID column, and that mistake only surfaces months
 * later when the first payslip goes to the wrong place.
 */
export function detectColumns(headers: string[]): ColumnMapping {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();

  for (const spec of EMPLOYEE_COLUMNS) {
    // The aliases are normalised too, not only the headers from the file.
    //
    // Without this, any alias containing punctuation would never match: the
    // header "E-Mail" becomes "e mail" after normalisation, while the alias
    // "e-mail" is compared as it is. Its column is then considered unrecognised,
    // its data is not read, and its validation does not run either — so an
    // invalid email address gets through without one complaint.
    //
    // This failure is entirely silent: the import still succeeds, its row count
    // is right, and all that is missing is one column nobody asked about.
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
 * Parses a date from an Excel cell.
 *
 * Three shapes have to be accepted, and all three are real:
 *
 *   - A Date object, when the cell really is date-formatted in Excel.
 *   - An Excel serial number, when the cell is numeric. Serial 1 is 1900-01-01,
 *     with the famous off-by-one because Excel treats 1900 as a leap year.
 *   - Text, because a hand-typed date column almost always ends up as text —
 *     and in Indonesia its form is dd/mm/yyyy, not mm/dd/yyyy.
 *
 * That day-month order is the most dangerous part: "03/04/2024" is valid under
 * both readings, and guessing wrong shifts someone's join date by thirty days
 * with not one error.
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
    // Excel serial: days since 1899-12-30. That offset already accounts for the
    // 1900 leap year bug Excel deliberately keeps for compatibility.
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
    // If the first number is > 12 it must be the day, and the order is not
    // ambiguous. If both are ≤ 12 we still read dd/mm — the Indonesian
    // convention — stated openly in the template rather than guessed silently.
    return buildDate(Number(dmy[3]), month, day);
  }

  return { date: null, error: `Format tanggal tidak dikenali: "${text}"` };
}

function buildDate(year: number, month: number, day: number): { date: string | null; error: string | null } {
  if (month < 1 || month > 12) return { date: null, error: `Bulan tidak sah: ${month}` };
  if (day < 1 || day > 31) return { date: null, error: `Tanggal tidak sah: ${day}` };

  const date = new Date(Date.UTC(year, month - 1, day));
  // Catches 31 February: Date shifts an invalid date into the next month without
  // complaint, so the result has to be checked back against the input.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { date: null, error: `Tanggal tidak ada dalam kalender: ${day}/${month}/${year}` };
  }
  if (year < 1900 || year > 2100) return { date: null, error: `Tahun di luar rentang: ${year}` };

  return { date: date.toISOString().slice(0, 10), error: null };
}

/**
 * A value that came from a masked export.
 *
 * The flow is real and easy to hit: someone without the `employee.pii.unmask`
 * permission exports the data, edits it in Excel, and imports it back. If that
 * passed, the real national ID would be overwritten with "3201********9012" —
 * silent damage that only surfaces when the first payroll run needs a bank
 * account number.
 *
 * The digit length check already refuses it, but its message reads "a national
 * ID is normally 16 digits (found 16 characters)" — which reads like a
 * contradiction and says nothing about how to fix it.
 *
 * The detection itself lives in `pii.ts`, where it also guards the other write
 * paths. It is used earlier here purely so the message can point at the row.
 */
const MASKED_MESSAGE =
  'Nilai tersamar (*) — berkas ini diekspor tanpa izin melihat data lengkap. ' +
  'Minta ekspor ulang dari pengguna yang berizin, atau kosongkan kolomnya.';

function parseGender(value: unknown): 'MALE' | 'FEMALE' | null {
  const text = cellText(value).toLowerCase();
  if (['l', 'lk', 'laki-laki', 'laki laki', 'pria', 'm', 'male'].includes(text)) return 'MALE';
  if (['p', 'pr', 'perempuan', 'wanita', 'f', 'female'].includes(text)) return 'FEMALE';
  return null;
}

/** Validates and normalises one row. */
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
    // A warning, not a refusal — a 16-digit national ID is the rule, but old
    // files contain foreign nationals and long-serving employees who do not
    // meet it. Refusing them means refusing the whole file.
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
