/**
 * Reading attendance machine export files (risk R8, PLAN/04).
 *
 * The strategy is not to write a per-vendor adapter. There are too many
 * fingerprint machine brands in Indonesia, and their firmware changes too often
 * for that, and the first tenant using an unsupported brand would stop on day
 * one. What is used here is generic column recognition — the same approach as
 * the employee Excel import, and for the same reason.
 *
 * Three shapes genuinely encountered in the field:
 *
 *   1. One date-time column      `PIN, DateTime, Status`
 *   2. Separate date and time    `No. ID, Tanggal, Jam, Verifikasi`
 *   3. No status column          `UserID, Timestamp`   ← the most common
 *
 * The third shape forces an unavoidable decision: the machine only records WHEN
 * someone put their finger on it, not whether they were arriving or leaving. The
 * rule is in `inferPunchTypes`, and its reasoning is there too.
 */

export type DeviceColumn = 'employeeNumber' | 'dateTime' | 'date' | 'time' | 'status';

/**
 * Column aliases, normalised before comparison.
 *
 * Written in already-normalised form — no spaces, no dots, lower case. The
 * employee import once had a bug exactly here: the headers were normalised but
 * the aliases were not, so `E-Mail` never matched the alias `e-mail` and its
 * column was silently unread.
 */
const ALIASES: Record<DeviceColumn, string[]> = {
  employeeNumber: [
    'pin',
    'userid',
    'user',
    'noid',
    'id',
    'nik',
    'nip',
    'employeeid',
    'employeeno',
    'nokaryawan',
    'idkaryawan',
    'badgenumber',
    'acnro',
    'acno',
  ],
  dateTime: [
    'datetime',
    'timestamp',
    'waktu',
    'tanggalwaktu',
    'checktime',
    'punchtime',
    'scantime',
    'logtime',
  ],
  date: ['date', 'tanggal', 'tgl', 'checkdate', 'workdate'],
  time: ['time', 'jam', 'waktuscan', 'checktimeonly'],
  status: ['status', 'state', 'verifikasi', 'verify', 'checktype', 'inout', 'keterangan', 'tipe'],
};

/** Strips everything that does not distinguish one column header from another. */
function normalize(header: string): string {
  return header
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

export interface DeviceColumnMapping {
  /** The column index per role. -1 means not found. */
  index: Record<DeviceColumn, number>;
  /** Required roles that were not found at all. */
  missing: string[];
  /** The headers as they were, to show back to the user. */
  headers: string[];
}

export function detectDeviceColumns(headers: string[]): DeviceColumnMapping {
  const index = {
    employeeNumber: -1,
    dateTime: -1,
    date: -1,
    time: -1,
    status: -1,
  } as Record<DeviceColumn, number>;

  headers.forEach((header, position) => {
    const key = normalize(header);
    if (key === '') return;

    for (const [role, aliases] of Object.entries(ALIASES) as Array<[DeviceColumn, string[]]>) {
      if (index[role] === -1 && aliases.includes(key)) {
        index[role] = position;
        return;
      }
    }
  });

  const missing: string[] = [];
  if (index.employeeNumber === -1) missing.push('nomor karyawan (PIN / User ID / NIK)');
  // The time may arrive as one column or as a separate date and time.
  if (index.dateTime === -1 && (index.date === -1 || index.time === -1)) {
    missing.push('waktu (kolom DateTime, atau kolom Tanggal dan Jam)');
  }

  return { index, missing, headers };
}

/**
 * Reads one time cell into a local wall clock time.
 *
 * What is returned is DELIBERATELY not a `Date`. An attendance machine file
 * carries no timezone — the figure `2026-08-10 08:05` in it means eight in the
 * morning where that machine is installed, and turning it into a `Date` here
 * would interpret it in the timezone of whichever process read the file. The
 * tenant's timezone is applied one layer above, where that timezone is known.
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DATE_PATTERNS: Array<{ re: RegExp; order: 'ymd' | 'dmy' }> = [
  { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/, order: 'ymd' },
  { re: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/, order: 'dmy' },
];

export function parseWallClock(dateCell: unknown, timeCell?: unknown): WallClock | null {
  // Excel stores a date as a Date when the cell really is date-typed.
  if (dateCell instanceof Date && !Number.isNaN(dateCell.getTime())) {
    const base = {
      year: dateCell.getUTCFullYear(),
      month: dateCell.getUTCMonth() + 1,
      day: dateCell.getUTCDate(),
      hour: dateCell.getUTCHours(),
      minute: dateCell.getUTCMinutes(),
    };
    const time = timeCell === undefined ? null : parseTime(timeCell);
    return time ? { ...base, ...time } : base;
  }

  const raw = String(dateCell ?? '').trim();
  if (raw === '') return null;

  // One column holding both: "2026-08-10 08:05:00", "10/08/2026 08:05".
  const [datePart, ...restParts] = raw.split(/[\sT]+/);
  const inlineTime = restParts.join(' ');

  const date = parseDate(datePart ?? '');
  if (!date) return null;

  const time = parseTime(timeCell ?? inlineTime);
  if (!time) return null;

  return { ...date, ...time };
}

function parseDate(text: string): Pick<WallClock, 'year' | 'month' | 'day'> | null {
  for (const { re, order } of DATE_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;

    const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // `dmy` is chosen for a separator format with the year last because that is
    // what Indonesian-language attendance machine software uses. Guessing `mdy`
    // would produce dates that are VALID but wrong on days 1 through 12 of every
    // month — a mistake that raises no error at all.
    const year = order === 'ymd' ? a! : c!;
    const month = order === 'ymd' ? b! : b!;
    const day = order === 'ymd' ? c! : a!;

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }
  return null;
}

function parseTime(cell: unknown): Pick<WallClock, 'hour' | 'minute'> | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { hour: cell.getUTCHours(), minute: cell.getUTCMinutes() };
  }

  const text = String(cell ?? '').trim();
  if (text === '') return null;

  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

export type PunchType = 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';

/**
 * Translates the machine's status column, where there is one.
 *
 * Returns `null` when the cell is empty or unrecognised — and `null` here means
 * "let the ordering decide", not "assume a clock-in". Guessing IN for an
 * unrecognised status would produce days with two clock-ins and no clock-out,
 * which then count as zero minutes worked.
 */
export function parseStatus(cell: unknown): PunchType | null {
  const key = normalize(String(cell ?? ''));
  if (key === '') return null;

  // Numeric: the ZKTeco convention — 0 in, 1 out, 2/3 break.
  if (/^\d+$/.test(key)) {
    const byCode: Record<string, PunchType> = {
      '0': 'IN',
      '1': 'OUT',
      '2': 'BREAK_START',
      '3': 'BREAK_END',
    };
    return byCode[key] ?? null;
  }

  // `cin`/`cout` come from the "C/In" and "C/Out" labels in ZKTeco software —
  // the form that appears most often in real files, and the easiest to miss
  // because it does not look like a word.
  if (['in', 'masuk', 'checkin', 'cin', 'datang', 'clockin', 'dutyon', 'i'].includes(key)) {
    return 'IN';
  }
  if (['out', 'pulang', 'checkout', 'cout', 'keluar', 'clockout', 'dutyoff', 'o'].includes(key)) {
    return 'OUT';
  }
  if (['breakout', 'obreak', 'istirahatmulai', 'mulaiistirahat'].includes(key)) {
    return 'BREAK_START';
  }
  if (['breakin', 'ibreak', 'istirahatselesai', 'selesaiistirahat'].includes(key)) {
    return 'BREAK_END';
  }

  return null;
}

export interface TimedPunch {
  /** The row index in the file, so an error can be pointed back at its cell. */
  rowNumber: number;
  employeeNumber: string;
  wallClock: WallClock;
  /** From the status column, where the machine provides one. */
  declaredType: PunchType | null;
}

/**
 * Decides the punch type when the machine does not state it.
 *
 * This is an unavoidable decision, and there is no answer that is right for
 * every case. The rule: **the first punch of a working day is a clock-in, the
 * rest are clock-outs.**
 *
 * Not alternating (in, out, in, out). Alternating looks cleverer and is more
 * fragile: one finger placement the machine failed to read — something that
 * happens every day — would flip the ENTIRE rest of that day, turning a leaving
 * time into an arrival time and producing negative hours rounded to zero.
 * dibulatkan menjadi nol.
 * The first-in-rest-out rule has no such failure mode. The daily calculation
 * already takes the first IN and the last OUT, so punches in the middle — lunch,
 * stepping out briefly — change nothing, and are still stored intact in case they
 * are needed later.
 */
export function inferPunchTypes(punches: TimedPunch[]): Array<TimedPunch & { type: PunchType }> {
  const seenFirst = new Set<string>();

  return [...punches]
    .sort((a, b) => compareWallClock(a.wallClock, b.wallClock))
    .map((punch) => {
      if (punch.declaredType) return { ...punch, type: punch.declaredType };

      // The day key uses the calendar date in the file, not the working date. A
      // working date needs the tenant's timezone and the night shift rules; all
      // that is needed here is "this person's first punch that day".
      const key = `${punch.employeeNumber}|${punch.wallClock.year}-${punch.wallClock.month}-${punch.wallClock.day}`;
      if (!seenFirst.has(key)) {
        seenFirst.add(key);
        return { ...punch, type: 'IN' as const };
      }
      return { ...punch, type: 'OUT' as const };
    });
}

function compareWallClock(a: WallClock, b: WallClock): number {
  return (
    a.year - b.year ||
    a.month - b.month ||
    a.day - b.day ||
    a.hour - b.hour ||
    a.minute - b.minute
  );
}
