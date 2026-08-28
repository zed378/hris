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
 * Bentuk PII yang disimpan pada baris pratinjau impor.
 *
 * Sama persis dengan yang disimpan tabel karyawan: terenkripsi, ber-indeks buta,
 * dan bertopeng. **Bukan** teks apa adanya.
 *
 * Ini menutup lubang yang membatalkan seluruh kerja enkripsi PII bagi jalur
 * onboarding yang paling banyak dipakai. `import_rows.raw` dan `.parsed`
 * menyimpan isi berkas apa adanya, dan berkas impor karyawan memuat kolom NIK,
 * NPWP, dan Nomor Rekening. Artinya: satu impor 500 karyawan meninggalkan 500
 * NIK sebagai **teks biasa** di dalam JSON, di basis data yang sama yang dengan
 * hati-hati mengenkripsi kolom NIK di tabel sebelahnya dengan AES-256-GCM.
 *
 * Yang membuatnya lebih buruk: tidak ada satu pun jalur yang menghapus baris
 * pratinjau. Status `DISCARDED` ada di enum sejak awal tanpa satu pun produsen,
 * sehingga pratinjau yang diunggah lalu ditinggalkan bertahan selamanya. HR yang
 * mencoba format berkasnya lima kali sebelum berhasil meninggalkan lima salinan.
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
 * Menyiapkan PII satu baris untuk disimpan, atau melaporkannya sebagai galat.
 *
 * Nilai yang ditolak `preparePii` — sudah bertopeng, atau tidak memuat satu pun
 * angka — menjadi galat baris biasa, bukan kegagalan seluruh impor. Satu sel
 * berisi "tidak ada" tidak boleh menggagalkan 999 baris lainnya.
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
 * Sel yang boleh disimpan untuk keperluan pesan galat.
 *
 * Bentuknya objek per-KOLOM YANG DIKENALI, bukan larik seluruh sel. Perbedaan
 * itu adalah perbaikannya sendiri.
 *
 * Versi pertama menyimpan seluruh sel apa adanya lalu menutupi kolom PII yang
 * **dikenali**. Uji e2e langsung menunjukkan lubangnya: berkas berjudul kolom
 * "NIK" meninggalkan nomor KTP lengkap di dalam JSON. Dan "NIK" tidak dikenali
 * BUKAN karena kelalaian — daftar aliasnya sengaja mengecualikannya, dengan
 * komentar yang berbunyi "menebak salah berarti menyimpan nomor identitas
 * nasional di kolom yang tidak terenkripsi". Kehati-hatian itu benar, lalu
 * dibatalkan oleh penyimpanan sel mentah yang tidak dipikirkan bersamanya.
 *
 * Dengan bentuk sekarang, kolom yang tidak dikenali tidak ikut tersimpan sama
 * sekali. Itu juga menutup kolom tambahan yang dibawa tenant sendiri — "Nama
 * Ibu Kandung", "Golongan Darah", "Nomor BPJS" — yang selama ini ikut terbawa
 * utuh tanpa ada yang memintanya.
 *
 * Kolom PII yang dikenali tetap disimpan sebagai bentuk bertopeng: cukup untuk
 * mengenali baris mana yang dimaksud, tidak cukup untuk menjadi salinan kedua
 * nomor identitas seseorang.
 *
 * Catatan jujur: **belum ada satu pun jalur yang membaca kolom ini.** Alasan ia
 * ada — "supaya pesan galat dapat menunjuk persis apa yang diketik pengguna" —
 * adalah rencana, bukan fitur. Ia dipertahankan karena rencana itu masuk akal
 * dan bentuk ini membuatnya aman; seandainya tetap tidak terpakai, kolomnya
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

    // PII disiapkan DI SINI, bukan saat commit.
    //
    // Sebelumnya `preparePii` dipanggil saat menyimpan karyawan, sehingga di
    // antara unggah dan simpan — jendela yang panjangnya ditentukan HR, dan
    // pada pratinjau yang ditinggalkan tidak pernah berakhir — NIK, NPWP, dan
    // nomor rekening berada sebagai teks biasa di dalam JSON.
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
        // Sudah tersiapkan sejak pratinjau — terenkripsi, ber-indeks, bertopeng.
        // Tidak ada teks biasa yang perlu diambil dari mana pun di sini.
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

    // Baris yang sudah tersimpan sebagai karyawan DIHAPUS, bukan ditandai.
    //
    // Ia sudah selesai menjalankan tugasnya. Yang tersisa hanyalah salinan
    // kedua data kepegawaian di tabel yang tidak diaudit pembacaannya, tidak
    // masuk ekspor portabilitas, dan tidak dihapus oleh apa pun — sementara
    // catatan aslinya sudah ada di tabel karyawan dengan seluruh penjagaannya.
    //
    // Ringkasannya tetap tersimpan pada `import_jobs`: berapa baris, berapa
    // yang tersimpan, siapa yang mengunggah, kapan. Itu yang dibutuhkan audit;
    // isi selnya tidak.
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


/**
 * Umur pratinjau impor sebelum dibuang.
 *
 * Tujuh hari. Cukup panjang bagi HR yang mengunggah Jumat sore lalu memeriksanya
 * Senin, dan cukup pendek untuk bukan disebut penyimpanan.
 */
export const PREVIEW_MAX_AGE_DAYS = 7;

export interface DiscardResult {
  jobs: number;
  rows: number;
}

/**
 * Membuang pratinjau impor yang ditinggalkan.
 *
 * Status `DISCARDED` ada di enum sejak migrasi pertama modul impor **tanpa satu
 * pun produsen** — pola yang sama dengan `LEAVE`, `MANUAL`, dan metode akrual:
 * nilai yang dideklarasikan tetapi tidak pernah dihasilkan siapa pun. Akibatnya
 * di sini bukan sekadar kosakata yang tidak terpakai: pratinjau yang diunggah
 * lalu ditinggalkan bertahan selamanya, dan HR yang mencoba format berkasnya
 * lima kali sebelum berhasil meninggalkan lima salinan data kepegawaian.
 *
 * Barisnya dihapus; ringkasan pekerjaannya tetap ada dengan status DISCARDED,
 * supaya "saya pernah mengunggah berkas itu, ke mana perginya" punya jawaban.
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
