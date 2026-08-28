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
 * Impor ketukan dari mesin absensi (dokumen 10 §5, risiko R8).
 *
 * Alur yang dilayani: mesin fingerprint di kantor mengekspor berkas, HR
 * mengunggahnya, dan ketukannya masuk ke sistem yang sama dengan presensi
 * ponsel. Bukan jalur pinggiran — bagi tenant dengan lokasi kerja tetap, inilah
 * jalur utamanya, dan presensi ponsel yang menjadi pelengkap (PLAN/10 §1).
 *
 * Dua sifat yang menanggung beban paling besar:
 *
 * **Idempoten.** Mesin absensi diekspor ulang terus-menerus, dan rentangnya
 * hampir selalu tumpang tindih dengan ekspor sebelumnya — HR mengunduh "bulan
 * ini" setiap minggu. Kunci dedupe dibangun dari isi ketukannya, sehingga
 * mengimpor berkas yang sama sepuluh kali menghasilkan baris yang sama persis.
 *
 * **Pratinjau lebih dulu.** Berkas mesin absensi memakai PIN, bukan nama. PIN
 * yang tidak terdaftar tidak terlihat salah — ia hanya tidak menghasilkan apa
 * pun. Tanpa pratinjau, HR mengimpor 3.000 baris dan tidak pernah tahu bahwa 400
 * di antaranya milik karyawan yang PIN-nya belum dipetakan.
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

/** Sebulan penuh untuk 500 karyawan dengan empat ketukan per hari ≈ 60.000. */
const MAX_ROWS = 60_000;

export interface DeviceImportIssue {
  rowNumber: number;
  /** Isi baris apa adanya, dipotong, supaya HR mengenali barisnya di berkas. */
  raw: string;
  reason: string;
}

export interface DeviceImportResult {
  fileName: string;
  committed: boolean;
  totalRows: number;
  /** Baris yang lolos validasi dan karyawannya ditemukan. */
  validRows: number;
  /** Baris yang sudah pernah diimpor sebelumnya. */
  duplicateRows: number;
  /** Baris yang benar-benar tersimpan pada pemanggilan ini. */
  insertedRows: number;
  /** Nomor karyawan pada berkas yang tidak ada di data karyawan. */
  unknownEmployees: string[];
  issues: DeviceImportIssue[];
  headers: string[];
  /** Rentang tanggal yang tercakup berkas, dalam zona tenant. */
  range: { from: string; to: string } | null;
}

/** Berapa banyak contoh galat yang dikembalikan. Bukan seluruhnya. */
const MAX_ISSUES = 50;

/**
 * Membaca berkas menjadi larik baris.
 *
 * CSV diurai sendiri alih-alih memakai pustaka. Berkas mesin absensi memakai
 * koma, titik koma, atau tab tergantung setelan regional Windows tempat
 * perangkat lunaknya berjalan — dan pemisahnya tidak pernah disebutkan di mana
 * pun. Mendeteksinya dari baris judul lebih andal daripada meminta HR menebak.
 */
function readDelimited(text: string): string[][] {
  // BOM ditulis sebagai escape, bukan karakternya sendiri: karakter tak terlihat
  // di dalam kode adalah hal yang tidak dapat ditinjau siapa pun.
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
        // Tanda kutip ganda di dalam kutipan berarti satu tanda kutip harfiah.
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

  // Baris kosong di akhir berkas adalah hal biasa dan bukan galat.
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

  // Pemetaan PIN → karyawan dilakukan sekali untuk seluruh berkas. Satu query
  // per baris akan berarti puluhan ribu query untuk satu unggahan.
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
        // Satu baris yang gagal tidak boleh membatalkan seluruh berkas. Ia
        // dilaporkan pada barisnya sendiri, dan sisanya tetap masuk — HR yang
        // mengimpor 3.000 ketukan tidak dapat berbuat apa-apa dengan kegagalan
        // yang hanya berkata "impor gagal".
        issues.push({
          rowNumber: punch.rowNumber,
          raw: punch.employeeNumber,
          reason: error instanceof Error ? error.message : 'Gagal disimpan',
        });
      }
    }
  } else {
    // Pratinjau menghitung berapa yang sudah ada tanpa menulis apa pun, supaya
    // angka "akan ditambahkan" yang dilihat HR adalah angka yang sebenarnya.
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
