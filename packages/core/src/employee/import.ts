import { EventTopic } from '@hrms/contracts';
import readXlsxFile from 'read-excel-file/node';
import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import { blindIndex, maskBankAccount, maskNationalId, maskTaxId, preparePii } from './pii.ts';
import {
  detectColumns,
  validateRow,
  type ColumnMapping,
  type ParsedRow,
  type RowError,
} from './import-schema.ts';
import type { ActorContext } from './employees.ts';

/**
 * Impor karyawan dari Excel (PLAN/12 Fase 2, Gerbang A).
 *
 * Selalu dua langkah: **unggah lalu tinjau**, baru simpan.
 *
 * Pratinjau bukan kenyamanan, ia satu-satunya cara membuat impor dapat
 * dibatalkan. Berkas pelanggan hampir tidak pernah bersih pada percobaan
 * pertama, dan impor sekali jalan yang berhasil separuh meninggalkan basis data
 * dalam keadaan yang tidak diinginkan siapa pun serta mahal untuk dikembalikan.
 *
 * Aturan yang mengikat: **satu baris bergalat tidak menggagalkan berkas.**
 * Impor yang berhenti di baris pertama yang salah memaksa pelanggan memperbaiki
 * 500 baris satu per satu, mengunggah ulang 500 kali. Yang benar adalah
 * memvalidasi semuanya, melaporkan seluruh galat sekaligus, dan menyimpan yang
 * sah bila pengguna memilih demikian.
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
  /** Nama sheet yang dibaca, dan berapa sheet yang ditemukan di berkas. */
  sheetName: string;
  sheetCount: number;
  totalRows: number;
  validRows: number;
  errorRows: number;
  columns: ColumnMapping;
  /** Contoh baris bergalat untuk ditampilkan. Bukan seluruhnya. */
  sampleErrors: Array<{ rowNumber: number; errors: RowError[]; name: string }>;
}

/**
 * Mengurai berkas, memvalidasi setiap baris, dan menyimpan hasilnya sebagai
 * pratinjau. Tidak ada satu pun karyawan yang dibuat di sini.
 */
export async function parseImportFile(
  tx: TenantClient,
  tenantId: string,
  file: { name: string; buffer: Buffer },
  ctx: ActorContext,
): Promise<ImportPreview> {
  /**
   * `readXlsxFile` mengembalikan daftar SHEET, bukan daftar baris: bentuknya
   * `[{ sheet, data }]`. Versi pertama memperlakukannya sebagai baris dan
   * membungkam keberatan TypeScript dengan cast — akibatnya setiap berkas
   * dilaporkan "kosong atau hanya berisi baris judul", karena panjang array
   * sheet memang 1.
   *
   * Kompilator sudah menyampaikannya lewat galat tipe. Cast itu yang membuatnya
   * diam.
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

  // Sheet pertama yang dipakai, dan namanya dikembalikan ke pengguna. Berkas HR
  // kerap memuat beberapa sheet ("Data", "Rekap", "Sheet1" kosong), dan diam-diam
  // membaca salah satu tanpa memberi tahu adalah cara termudah membuat seseorang
  // mengimpor data yang salah tanpa menyadarinya.
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

  // Duplikat diperiksa terhadap dua sumber: data yang sudah ada di basis data,
  // dan baris-baris lain di dalam berkas yang sama. Yang kedua sering terlewat,
  // padahal berkas hasil gabungan beberapa cabang justru paling sering memuatnya.
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

    // Baris yang seluruh selnya kosong dilewati diam-diam. Berkas Excel hampir
    // selalu punya beberapa ratus baris kosong di bawah data, dan melaporkannya
    // sebagai galat akan mengubur galat yang sesungguhnya.
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
      const index = blindIndex(parsed.nationalId);
      if (takenNationalIds.has(index)) {
        errors.push({ field: 'nationalId', message: 'NIK ini sudah terdaftar di sistem' });
      }
      const firstSeen = seenNationalIds.get(index);
      if (firstSeen !== undefined) {
        errors.push({ field: 'nationalId', message: `NIK ini juga ada di baris ${firstSeen}` });
      } else {
        seenNationalIds.set(index, rowNumber);
      }
    }

    if (errors.length === 0) validRows += 1;

    rows.push({
      tenantId,
      jobId: job.id,
      rowNumber,
      // Sel mentah disimpan supaya pesan galat dapat menunjuk persis apa yang
      // diketik pengguna, bukan hasil tafsiran kita atasnya.
      raw: cells.map((cell) => (cell instanceof Date ? cell.toISOString() : cell)),
      parsed: parsed as unknown,
      errors: errors.length > 0 ? errors : null,
      status: errors.length > 0 ? 'ERROR' : 'VALID',
    });
  }

  // Disisipkan berbatch. Satu `createMany` berisi 10.000 baris membangun satu
  // pernyataan raksasa yang memakan memori di kedua sisi koneksi.
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
 * Menyimpan baris yang sah dari sebuah pratinjau.
 *
 * Baris bergalat dilewati, bukan menggagalkan seluruhnya. Pengguna memperbaikinya
 * di Excel dan mengunggah ulang — dan karena nomor karyawan yang sudah masuk kini
 * terdeteksi sebagai duplikat, unggahan kedua tidak menggandakan siapa pun.
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
        const parsed = row.parsed as unknown as ParsedRow;
        const nationalId = preparePii(parsed.nationalId, maskNationalId);
        const taxId = preparePii(parsed.taxId, maskTaxId);
        const bankAccount = preparePii(parsed.bankAccount, maskBankAccount);

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

    await tx.importRow.updateMany({
      where: { id: { in: batch.map((row) => row.id) } },
      data: { status: 'COMMITTED' },
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
    // Jumlah, bukan isi. Berkas impor memuat seluruh PII sekaligus; menyalin
    // apa pun darinya ke tabel audit yang disimpan tujuh tahun akan membatalkan
    // seluruh kerja enkripsi.
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

/** Rincian pratinjau, termasuk seluruh baris bergalat untuk ditampilkan di grid. */
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
