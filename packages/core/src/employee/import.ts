import { EventTopic } from '@hrms/contracts';
import readXlsxFile from 'read-excel-file/node';
import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import { blindIndexCandidates, maskBankAccount, maskNationalId, maskTaxId, preparePii } from './pii.ts';
import {
  detectColumns,
  validateRow,
  type ColumnMapping,
  type ParsedRow,
  type RowError,
} from './import-schema.ts';
import type { ActorContext } from './employees.ts';

/**
 * Employee import from Excel (PLAN/12 Phase 2, Gate A).
 *
 * Always two steps: **upload then review**, and only then save.
 *
 * The preview is not a convenience, it is the only thing that makes an import
 * cancellable. A customer's file is almost never clean on the first attempt, and
 * a one-shot import that half succeeds leaves the database in a state nobody
 * wanted and that is expensive to undo.
 *
 * The binding rule: **one bad row does not fail the file.** An import that stops
 * at the first wrong row forces the customer to fix 500 rows one at a time and
 * re-upload 500 times. The right thing is to validate everything, report every
 * error at once, and save the valid rows if the user chooses to.
 */

const MAX_ROWS = 10_000;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_file' | 'too_large' | 'not_found' | 'conflict',
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportPreview {
  jobId: string;
  fileName: string;
  /** The sheet name that was read, and how many sheets the file contained. */
  sheetName: string;
  sheetCount: number;
  totalRows: number;
  validRows: number;
  errorRows: number;
  columns: ColumnMapping;
  /** A sample of the failing rows to display. Not all of them. */
  sampleErrors: Array<{ rowNumber: number; errors: RowError[]; name: string }>;
}

/**
 * The shape of the PII stored on an import preview row.
 *
 * Exactly what the employee table stores: encrypted, blind-indexed, and masked.
 * **Not** plain text.
 *
 * This closes a hole that voided the entire PII encryption effort for the
 * most-used onboarding path. `import_rows.raw` and `.parsed` stored the file's
 * contents as they were, and an employee import file contains the national ID,
 * tax ID, and bank account columns. Which means: one 500-employee import left
 * 500 national IDs as **plain text** inside JSON, in the same database that
 * carefully encrypts the national ID column in the table next to it with
 * AES-256-GCM.
 *
 * What made it worse: no path deleted a preview row. The `DISCARDED` status had
 * been in the enum from the start with not one producer, so a preview uploaded
 * and then abandoned survived forever. HR trying their file format five times
 * before it worked left five copies behind.
 */
interface PreparedPii {
  encrypted: string | null;
  index: string | null;
  masked: string | null;
}

export interface StoredRow extends Omit<ParsedRow, 'nationalId' | 'taxId' | 'bankAccount'> {
  nationalId: PreparedPii;
  taxId: PreparedPii;
  bankAccount: PreparedPii;
}

/**
 * Prepares one row's PII for storage, or reports it as an error.
 *
 * A value `preparePii` refuses — already masked, or containing not one digit —
 * becomes an ordinary row error, not a failure of the whole import. One cell
 * reading "tidak ada" must not fail the other 999 rows.
 */
export function prepareRowPii(
  parsed: ParsedRow,
  errors: RowError[],
): StoredRow {
  const fields = [
    { key: 'nationalId', label: 'NIK', value: parsed.nationalId, mask: maskNationalId },
    { key: 'taxId', label: 'NPWP', value: parsed.taxId, mask: maskTaxId },
    { key: 'bankAccount', label: 'Nomor Rekening', value: parsed.bankAccount, mask: maskBankAccount },
  ] as const;

  const prepared: Record<string, PreparedPii> = {};

  for (const field of fields) {
    try {
      prepared[field.key] = preparePii(field.value, field.mask, field.label);
    } catch (error) {
      errors.push({
        field: field.key,
        message: error instanceof Error ? error.message : `${field.label} tidak sah`,
      });
      prepared[field.key] = { encrypted: null, index: null, masked: null };
    }
  }

  const { nationalId: _n, taxId: _t, bankAccount: _b, ...rest } = parsed;

  return {
    ...rest,
    nationalId: prepared['nationalId']!,
    taxId: prepared['taxId']!,
    bankAccount: prepared['bankAccount']!,
  };
}

/**
 * The cells that may be stored for the sake of error messages.
 *
 * Its shape is an object of RECOGNISED COLUMNS, not an array of every cell.
 * That difference is the fix itself.
 *
 * The first version stored every cell as it was and then masked the
 * **recognised** PII columns. An e2e test showed the hole immediately: a file
 * with a column headed "NIK" left complete ID card numbers inside the JSON. And
 * "NIK" being unrecognised was NOT an oversight — the alias list excludes it
 * deliberately, with a comment reading "guessing wrong means storing a national
 * identity number in an unencrypted column". That caution was right, and then
 * undone by a raw cell store that was not thought through alongside it.
 *
 * In its present shape, an unrecognised column is not stored at all. That also
 * closes the custom columns a tenant brings themselves — "Nama Ibu Kandung",
 * "Golongan Darah", "Nomor BPJS" — which until now were carried along intact
 * without anyone asking.
 *
 * A recognised PII column is still stored in masked form: enough to tell which
 * row is meant, not enough to become a second copy of someone's identity
 * number.
 *
 * An honest note: **no path reads this column yet.** Its stated reason — "so an
 * error message can point at exactly what the user typed" — is a plan, not a
 * feature. It is kept because the plan is reasonable and this shape makes it
 * safe; if it stays unused, the column deserves deleting.
 * layak dihapus.
 */
const PII_FIELDS = new Set(['nationalId', 'taxId', 'bankAccount']);

export function buildRawForStorage(
  cells: readonly unknown[],
  mapping: Readonly<Record<string, number>>,
  stored: StoredRow,
): Record<string, unknown> {
  const masked: Record<string, string | null> = {
    nationalId: stored.nationalId.masked,
    taxId: stored.taxId.masked,
    bankAccount: stored.bankAccount.masked,
  };

  const out: Record<string, unknown> = {};

  for (const [field, index] of Object.entries(mapping)) {
    const cell = cells[index];
    if (cell === null || cell === undefined || String(cell).trim() === '') continue;

    out[field] = PII_FIELDS.has(field)
      ? (masked[field] ?? '••••')
      : cell instanceof Date
        ? cell.toISOString()
        : cell;
  }

  return out;
}

/**
 * Parses the file, validates every row, and stores the result as a preview.
 * Not one employee is created here.
 */
export async function parseImportFile(
  tx: TenantClient,
  tenantId: string,
  file: { name: string; buffer: Buffer },
  ctx: ActorContext,
): Promise<ImportPreview> {
  /**
   * `readXlsxFile` returns a list of SHEETS, not a list of rows: its shape is
   * `[{ sheet, data }]`. The first version treated it as rows and silenced
   * TypeScript's objection with a cast — so every file was reported as "empty or
   * containing only a header row", because the sheet array's length really is 1.
   *
   * The compiler had already said so through a type error. That cast is what
   * silenced it.
   */
  let sheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    sheets = (await readXlsxFile(file.buffer)) as never;
  } catch {
    throw new ImportError(
      'Berkas tidak dapat dibaca. Pastikan berformat .xlsx, bukan .xls atau CSV.',
      'invalid_file',
    );
  }

  // The first sheet is used, and its name is returned to the user. An HR file
  // often contains several sheets ("Data", "Rekap", an empty "Sheet1"), and
  // silently reading one without saying so is the easiest way to make someone
  // import the wrong data without realising.
  const first = sheets[0];
  const sheet = first?.data ?? [];

  if (sheet.length < 2) {
    throw new ImportError(
      `Sheet "${first?.sheet ?? "?"}" kosong atau hanya berisi baris judul.`,
      'invalid_file',
    );
  }
  if (sheet.length - 1 > MAX_ROWS) {
    throw new ImportError(
      `Berkas berisi ${sheet.length - 1} baris; batasnya ${MAX_ROWS}. Bagi menjadi beberapa berkas.`,
      'too_large',
    );
  }

  const headers = (sheet[0] ?? []).map((cell) => String(cell ?? ''));
  const columns = detectColumns(headers);

  if (columns.missingRequired.length > 0) {
    throw new ImportError(
      `Kolom wajib tidak ditemukan: ${columns.missingRequired.join(', ')}. ` +
        'Unduh templat untuk melihat judul kolom yang dikenali.',
      'invalid_file',
    );
  }

  const job = await tx.importJob.create({
    data: {
      tenantId,
      kind: 'employee',
      fileName: file.name,
      createdBy: ctx.actorUserId,
      totalRows: sheet.length - 1,
    },
    select: { id: true },
  });

  // Duplicates are checked against two sources: the data already in the database,
  // and the other rows inside the same file. The second is often overlooked,
  // even though a file merged from several branches is where they occur most.
  const existing = await tx.employee.findMany({
    where: { tenantId },
    select: { employeeNumber: true, nationalIdIndex: true },
  });
  const takenNumbers = new Set(existing.map((e) => e.employeeNumber));
  const takenNationalIds = new Set(existing.map((e) => e.nationalIdIndex).filter(Boolean));

  const seenNumbers = new Map<string, number>();
  const seenNationalIds = new Map<string, number>();

  const rows: Array<{
    tenantId: string;
    jobId: string;
    rowNumber: number;
    raw: unknown;
    parsed: unknown;
    errors: unknown;
    status: 'VALID' | 'ERROR';
  }> = [];

  let validRows = 0;

  for (let i = 1; i < sheet.length; i += 1) {
    const cells = sheet[i] ?? [];
    const rowNumber = i + 1; // 1-indeks, dan baris 1 adalah judul.

    // A row whose cells are all empty is skipped silently. An Excel file almost
    // always has a few hundred empty rows below the data, and reporting them as
    // errors would bury the real ones.
    if (cells.every((cell) => cell === null || cell === undefined || String(cell).trim() === '')) {
      continue;
    }

    const { parsed, errors } = validateRow(cells, columns.mapping);

    if (parsed.employeeNumber !== '') {
      if (takenNumbers.has(parsed.employeeNumber)) {
        errors.push({
          field: 'employeeNumber',
          message: `Nomor karyawan "${parsed.employeeNumber}" sudah ada di sistem`,
        });
      }
      const firstSeen = seenNumbers.get(parsed.employeeNumber);
      if (firstSeen !== undefined) {
        errors.push({
          field: 'employeeNumber',
          message: `Nomor karyawan "${parsed.employeeNumber}" juga ada di baris ${firstSeen}`,
        });
      } else {
        seenNumbers.set(parsed.employeeNumber, rowNumber);
      }
    }

    if (parsed.nationalId) {
      // Checked against every candidate index for the same reason as
      // `findByNationalId`: mid-rotation, the stored index of an existing
      // employee was computed with the previous key. Missing it here does not
      // report an error — it silently imports a second copy of a person.
      const candidates = blindIndexCandidates(parsed.nationalId);
      const index = candidates[0]!;
      if (candidates.some((candidate) => takenNationalIds.has(candidate))) {
        errors.push({ field: 'nationalId', message: 'NIK ini sudah terdaftar di sistem' });
      }
      const firstSeen = seenNationalIds.get(index);
      if (firstSeen !== undefined) {
        errors.push({ field: 'nationalId', message: `NIK ini juga ada di baris ${firstSeen}` });
      } else {
        seenNationalIds.set(index, rowNumber);
      }
    }

    // The PII is prepared HERE, not at commit time.
    //
    // Previously `preparePii` was called when saving the employee, so between
    // upload and save — a window whose length HR decides, and which never ends
    // for an abandoned preview — the national ID, tax ID, and bank account sat
    // as plain text inside the JSON.
    const stored = prepareRowPii(parsed, errors);

    if (errors.length === 0) validRows += 1;

    rows.push({
      tenantId,
      jobId: job.id,
      rowNumber,
      raw: buildRawForStorage(cells, columns.mapping, stored),
      parsed: stored as unknown,
      errors: errors.length > 0 ? errors : null,
      status: errors.length > 0 ? 'ERROR' : 'VALID',
    });
  }

  // Inserted in batches. One `createMany` holding 10,000 rows builds a single
  // enormous statement that consumes memory on both ends of the connection.
  for (let i = 0; i < rows.length; i += 500) {
    await tx.importRow.createMany({ data: rows.slice(i, i + 500) as never });
  }

  const errorRows = rows.length - validRows;
  await tx.importJob.update({
    where: { id: job.id },
    data: { totalRows: rows.length, validRows, errorRows },
  });

  const sampleErrors = rows
    .filter((row) => row.status === 'ERROR')
    .slice(0, 20)
    .map((row) => ({
      rowNumber: row.rowNumber,
      errors: row.errors as RowError[],
      name: (row.parsed as ParsedRow).fullName,
    }));

  return {
    jobId: job.id,
    fileName: file.name,
    sheetName: first?.sheet ?? '',
    sheetCount: sheets.length,
    totalRows: rows.length,
    validRows,
    errorRows,
    columns,
    sampleErrors,
  };
}

export interface CommitResult {
  committed: number;
  skipped: number;
}

/**
 * Saves the valid rows of a preview.
 *
 * Failing rows are skipped rather than failing everything. The user fixes them
 * in Excel and re-uploads — and because an employee number already imported is
 * now detected as a duplicate, the second upload duplicates nobody.
 */
export async function commitImport(
  tx: TenantClient,
  tenantId: string,
  jobId: string,
  ctx: ActorContext,
): Promise<CommitResult> {
  const job = await tx.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, status: true, fileName: true },
  });
  if (!job) throw new ImportError('Pratinjau impor tidak ditemukan', 'not_found');
  if (job.status !== 'PREVIEW') {
    throw new ImportError('Pratinjau ini sudah disimpan atau dibatalkan', 'conflict');
  }

  const validRows = await tx.importRow.findMany({
    where: { jobId, tenantId, status: 'VALID' },
    orderBy: { rowNumber: 'asc' },
    select: { id: true, parsed: true },
  });

  let committed = 0;

  for (let i = 0; i < validRows.length; i += 200) {
    const batch = validRows.slice(i, i + 200);

    await tx.employee.createMany({
      data: batch.map((row) => {
        // Already prepared at preview time — encrypted, indexed, masked. There is
        // no plain text to fetch from anywhere here.
        const parsed = row.parsed as unknown as StoredRow;
        const { nationalId, taxId, bankAccount } = parsed;

        return {
          tenantId,
          employeeNumber: parsed.employeeNumber,
          fullName: parsed.fullName,
          email: parsed.email,
          phone: parsed.phone,
          birthDate: parsed.birthDate ? new Date(parsed.birthDate) : null,
          birthPlace: parsed.birthPlace,
          gender: parsed.gender,
          address: parsed.address,
          bankName: parsed.bankName,
          joinDate: new Date(parsed.joinDate!),
          nationalIdEncrypted: nationalId.encrypted,
          nationalIdIndex: nationalId.index,
          nationalIdMasked: nationalId.masked,
          taxIdEncrypted: taxId.encrypted,
          taxIdIndex: taxId.index,
          taxIdMasked: taxId.masked,
          bankAccountEncrypted: bankAccount.encrypted,
          bankAccountMasked: bankAccount.masked,
        };
      }),
    });

    // A row already stored as an employee is DELETED, not flagged.
    //
    // It has finished its job. What remains is only a second copy of personnel
    // data in a table whose reads are not audited, that is not part of the
    // portability export, and that nothing deletes — while the original record
    // already sits in the employee table with all of its guards.
    //
    // Its summary stays in `import_jobs`: how many rows, how many stored, who
    // uploaded it, when. That is what an audit needs; the cell contents are not.
    await tx.importRow.deleteMany({
      where: { id: { in: batch.map((row) => row.id) } },
    });

    committed += batch.length;
  }

  const errorRows = await tx.importRow.count({ where: { jobId, tenantId, status: 'ERROR' } });

  await tx.importJob.update({
    where: { id: jobId },
    data: { status: 'COMMITTED', committedRows: committed, committedAt: new Date() },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.import.committed',
    entityType: 'import_job',
    entityId: jobId,
    actorUserId: ctx.actorUserId,
    // Counts, not contents. An import file carries all of the PII at once; copying
    // any of it into an audit table kept for seven years would void the entire
    // encryption effort.
    after: { fileName: job.fileName, committed, skipped: errorRows },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  await publishEvent(tx, tenantId, {
    topic: EventTopic.EMPLOYEE_IMPORT_COMMITTED,
    payload: { tenantId, jobId, committed },
    correlationId: ctx.correlationId,
  });

  return { committed, skipped: errorRows };
}

/** Preview detail, including every failing row so the grid can display them. */
export async function getImportPreview(
  tx: TenantClient,
  tenantId: string,
  jobId: string,
  options: { onlyErrors?: boolean; limit?: number; offset?: number } = {},
): Promise<{
  job: { id: string; fileName: string; status: string; totalRows: number; validRows: number; errorRows: number };
  rows: Array<{ rowNumber: number; parsed: ParsedRow; errors: RowError[] | null; status: string }>;
}> {
  const job = await tx.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true,
      fileName: true,
      status: true,
      totalRows: true,
      validRows: true,
      errorRows: true,
    },
  });
  if (!job) throw new ImportError('Pratinjau impor tidak ditemukan', 'not_found');

  const rows = await tx.importRow.findMany({
    where: { jobId, tenantId, ...(options.onlyErrors ? { status: 'ERROR' } : {}) },
    orderBy: { rowNumber: 'asc' },
    take: Math.min(options.limit ?? 100, 500),
    skip: options.offset ?? 0,
    select: { rowNumber: true, parsed: true, errors: true, status: true },
  });

  return {
    job,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      parsed: row.parsed as unknown as ParsedRow,
      errors: row.errors as RowError[] | null,
      status: row.status,
    })),
  };
}


/**
 * How long an import preview lives before being discarded.
 *
 * Seven days. Long enough for HR who uploads on a Friday afternoon and checks it
 * on Monday, and short enough not to count as storage.
 */
export const PREVIEW_MAX_AGE_DAYS = 7;

export interface DiscardResult {
  jobs: number;
  rows: number;
}

/**
 * Discards abandoned import previews.
 *
 * The `DISCARDED` status has been in the enum since the import module's first
 * migration **with not one producer** — the same pattern as `LEAVE`, `MANUAL`,
 * and the accrual methods: a value declared but never produced by anyone. Here
 * the consequence is more than unused vocabulary: a preview uploaded and then
 * abandoned survived forever, and HR trying their file format five times before
 * it worked left five copies of their personnel data.
 *
 * Its rows are deleted; the job summary stays with a DISCARDED status, so "I did
 * upload that file, where did it go" has an answer.
 */
export async function discardStalePreviews(
  tx: TenantClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<DiscardResult> {
  const cutoff = new Date(now.getTime() - PREVIEW_MAX_AGE_DAYS * 86_400_000);

  const stale = await tx.importJob.findMany({
    where: { tenantId, status: 'PREVIEW', createdAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return { jobs: 0, rows: 0 };

  const ids = stale.map((job) => job.id);

  const removed = await tx.importRow.deleteMany({ where: { tenantId, jobId: { in: ids } } });
  await tx.importJob.updateMany({
    where: { tenantId, id: { in: ids } },
    data: { status: 'DISCARDED' },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.import.discarded',
    entityType: 'import_job',
    after: { jobs: ids.length, rows: removed.count, olderThanDays: PREVIEW_MAX_AGE_DAYS },
  });

  return { jobs: ids.length, rows: removed.count };
}
