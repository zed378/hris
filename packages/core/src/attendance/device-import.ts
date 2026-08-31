import readXlsxFile from 'read-excel-file/node';
import type { TenantClient } from '@hrms/db';
import { recordPunch, PunchError } from './punch.ts';
import { localMinutesToInstant, tenantTimeZone } from './workdate.ts';
import {
  detectDeviceColumns,
  inferPunchTypes,
  parseStatus,
  parseWallClock,
  type TimedPunch,
} from './device-format.ts';

/**
 * Importing punches from an attendance machine (document 10 §5, risk R8).
 *
 * The flow it serves: the fingerprint machine in the office exports a file, HR
 * uploads it, and its punches enter the same system as phone punches. Not a
 * side path — for a tenant with fixed work sites this is the main path, and
 * phone punching is the complement (PLAN/10 §1).
 *
 * Two properties carry the most weight:
 *
 * **Idempotent.** An attendance machine is exported over and over, and its range
 * almost always overlaps the previous export — HR downloads "this month" every
 * week. The dedupe key is built from the punch's own contents, so importing the
 * same file ten times produces exactly the same rows.
 *
 * **Preview first.** An attendance machine file uses PINs, not names. An
 * unregistered PIN does not look wrong — it simply produces nothing. Without a
 * preview, HR imports 3,000 rows and never learns that 400 of them belong to
 * employees whose PIN has not been mapped.
 */

export class DeviceImportError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_file' | 'too_large' | 'no_columns',
  ) {
    super(message);
    this.name = 'DeviceImportError';
  }
}

/** A full month for 500 employees at four punches a day ≈ 60,000. */
const MAX_ROWS = 60_000;

export interface DeviceImportIssue {
  rowNumber: number;
  /** The row's contents as they are, truncated, so HR can find it in the file. */
  raw: string;
  reason: string;
}

export interface DeviceImportResult {
  fileName: string;
  committed: boolean;
  totalRows: number;
  /** Rows that passed validation and whose employee was found. */
  validRows: number;
  /** Rows that had already been imported before. */
  duplicateRows: number;
  /** Rows genuinely stored on this call. */
  insertedRows: number;
  /** Employee numbers in the file that are absent from the employee data. */
  unknownEmployees: string[];
  issues: DeviceImportIssue[];
  headers: string[];
  /** The date range the file covers, in the tenant's timezone. */
  range: { from: string; to: string } | null;
}

/** How many error samples are returned. Not all of them. */
const MAX_ISSUES = 50;

/**
 * Reads the file into an array of rows.
 *
 * The CSV is parsed here rather than with a library. An attendance machine file
 * uses commas, semicolons, or tabs depending on the regional settings of the
 * Windows machine its software runs on — and its separator is never stated
 * anywhere. Detecting it from the header row is more reliable than asking HR to
 * guess.
 */
function readDelimited(text: string): string[][] {
  // The BOM is written as an escape rather than the character itself: an
  // invisible character inside code is something nobody can review.
  const withoutBom = text.replace(/^\uFEFF/, '');
  const firstLine = withoutBom.split(/\r?\n/, 1)[0] ?? '';

  const delimiter = ([';', '\t', ','] as const)
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length }))
    .sort((a, b) => b.count - a.count)[0]!.candidate;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < withoutBom.length; i += 1) {
    const char = withoutBom[i]!;

    if (quoted) {
      if (char === '"') {
        // A double quote inside a quoted field means one literal quote.
        if (withoutBom[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Blank lines at the end of a file are ordinary and not an error.
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''));
}

async function readRows(file: { name: string; buffer: Buffer }): Promise<unknown[][]> {
  const isSpreadsheet = /\.xlsx?$/i.test(file.name);

  if (isSpreadsheet) {
    let sheets: Array<{ sheet: string; data: unknown[][] }>;
    try {
      sheets = (await readXlsxFile(file.buffer)) as never;
    } catch {
      throw new DeviceImportError(
        'Berkas .xlsx tidak dapat dibaca. Bila berkasnya .xls lama, simpan ulang sebagai .xlsx atau .csv.',
        'invalid_file',
      );
    }
    return sheets[0]?.data ?? [];
  }

  return readDelimited(file.buffer.toString('utf8'));
}

export async function importDevicePunches(
  tx: TenantClient,
  tenantId: string,
  file: { name: string; buffer: Buffer },
  actorUserId: string,
  options: { commit: boolean },
): Promise<DeviceImportResult> {
  const rows = await readRows(file);

  if (rows.length < 2) {
    throw new DeviceImportError(
      'Berkas kosong atau hanya berisi baris judul.',
      'invalid_file',
    );
  }
  if (rows.length - 1 > MAX_ROWS) {
    throw new DeviceImportError(
      `Berkas berisi ${rows.length - 1} baris; batasnya ${MAX_ROWS}. Ekspor per bulan, bukan per tahun.`,
      'too_large',
    );
  }

  const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
  const mapping = detectDeviceColumns(headers);

  if (mapping.missing.length > 0) {
    throw new DeviceImportError(
      `Kolom yang tidak ditemukan: ${mapping.missing.join('; ')}. ` +
        `Judul yang terbaca: ${headers.filter(Boolean).join(', ') || '(kosong)'}.`,
      'no_columns',
    );
  }

  const { index } = mapping;
  const issues: DeviceImportIssue[] = [];
  const parsed: TimedPunch[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const rowNumber = i + 1;
    const raw = row.map((cell) => String(cell ?? '')).join(' | ').slice(0, 120);

    const employeeNumber = String(row[index.employeeNumber] ?? '').trim();
    if (employeeNumber === '') {
      issues.push({ rowNumber, raw, reason: 'Nomor karyawan kosong' });
      continue;
    }

    const wallClock =
      index.dateTime !== -1
        ? parseWallClock(row[index.dateTime])
        : parseWallClock(row[index.date], row[index.time]);

    if (!wallClock) {
      issues.push({ rowNumber, raw, reason: 'Waktu tidak dapat dibaca' });
      continue;
    }

    parsed.push({
      rowNumber,
      employeeNumber,
      wallClock,
      declaredType: index.status !== -1 ? parseStatus(row[index.status]) : null,
    });
  }

  const typed = inferPunchTypes(parsed);

  // The PIN → employee mapping is done once for the whole file. One query per row
  // would mean tens of thousands of queries for one upload.
  const numbers = [...new Set(typed.map((punch) => punch.employeeNumber))];
  const employees = await tx.employee.findMany({
    where: { tenantId, employeeNumber: { in: numbers } },
    select: { id: true, employeeNumber: true },
  });
  const byNumber = new Map(employees.map((employee) => [employee.employeeNumber, employee.id]));

  const unknownEmployees = numbers.filter((number) => !byNumber.has(number)).sort();

  const timeZone = await tenantTimeZone(tx, tenantId);
  const toInstant = (wall: TimedPunch['wallClock']): Date =>
    localMinutesToInstant(
      new Date(Date.UTC(wall.year, wall.month - 1, wall.day)),
      wall.hour * 60 + wall.minute,
      timeZone,
    );

  const resolvable = typed.filter((punch) => byNumber.has(punch.employeeNumber));

  for (const punch of typed) {
    if (!byNumber.has(punch.employeeNumber)) {
      issues.push({
        rowNumber: punch.rowNumber,
        raw: punch.employeeNumber,
        reason: `Nomor karyawan "${punch.employeeNumber}" tidak terdaftar`,
      });
    }
  }

  const dedupeKeyFor = (punch: (typeof resolvable)[number]): string =>
    `device:${punch.employeeNumber}:${punch.type}:${toInstant(punch.wallClock).toISOString()}`;

  let duplicateRows = 0;
  let insertedRows = 0;

  if (options.commit) {
    for (const punch of resolvable) {
      try {
        const result = await recordPunch(
          tx,
          tenantId,
          {
            employeeId: byNumber.get(punch.employeeNumber)!,
            type: punch.type,
            source: 'DEVICE',
            punchedAt: toInstant(punch.wallClock),
            dedupeKey: dedupeKeyFor(punch),
            deviceInfo: `import:${file.name}`.slice(0, 255),
          },
          actorUserId,
        );
        if (result.duplicate) duplicateRows += 1;
        else insertedRows += 1;
      } catch (error) {
        if (error instanceof PunchError && error.kind === 'duplicate') {
          duplicateRows += 1;
          continue;
        }
        // One failing row must not cancel the whole file. It is reported on its
        // own row and the rest still go in — HR importing 3,000 punches can do
        // nothing with a failure that only says "import failed".
        issues.push({
          rowNumber: punch.rowNumber,
          raw: punch.employeeNumber,
          reason: error instanceof Error ? error.message : 'Gagal disimpan',
        });
      }
    }
  } else {
    // A preview counts how many already exist without writing anything, so the
    // "will be added" figure HR sees is the real one.
    const keys = resolvable.map(dedupeKeyFor);
    const existing = await tx.punchLog.findMany({
      where: { tenantId, dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    duplicateRows = existing.length;
    insertedRows = resolvable.length - duplicateRows;
  }

  const sorted = resolvable.map((punch) => toInstant(punch.wallClock)).sort((a, b) => +a - +b);

  return {
    fileName: file.name,
    committed: options.commit,
    totalRows: rows.length - 1,
    validRows: resolvable.length,
    duplicateRows,
    insertedRows,
    unknownEmployees,
    issues: issues.slice(0, MAX_ISSUES),
    headers: headers.filter(Boolean),
    range:
      sorted.length > 0
        ? {
            from: sorted[0]!.toISOString(),
            to: sorted[sorted.length - 1]!.toISOString(),
          }
        : null,
  };
}
