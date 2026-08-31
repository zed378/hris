import { type DocumentKind } from '@hrms/contracts';
import { writeAudit, type TenantClient } from '@hrms/db';
import { createBlobStore, BlobError } from '../storage/index.ts';

/**
 * Employee documents (PLAN/12 P2).
 *
 * What is stored here is not an ordinary attachment: scans of an ID card, a
 * family card, a diploma, a contract. All of it is personal data under Personal
 * Data Protection Act No. 27/2022, and some of it is enough to open a bank
 * account in someone else's name.
 *
 * Three properties follow from that:
 *
 *   1. **File types are restricted.** PDF and images only. Accepting arbitrary
 *      files means storing an executable attachment on the same server as the
 *      salary data.
 *   2. **Reads are logged.** In line with attendance photos: the question "who
 *      has opened the scan of my ID card" has to be answerable.
 *   3. **Nothing is deleted, only archived.** Rule M4 of document 09. The
 *      physical file may go; its row survives so the history of "this document
 *      existed, uploaded by whom" does not go with it.

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'invalid_type' | 'too_large' | 'archived',
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

// The kind list lives in `@hrms/contracts` so the upload screen — a client
// component — can use it without pulling Prisma into the browser bundle.
// Re-exported here so callers in the employee module need not know that.
export { DOCUMENT_KINDS, type DocumentKind } from '@hrms/contracts';


/** A reasonable-resolution ID card scan ≈ 1-3 MB; a colour diploma can be 8 MB. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * The accepted file types, with their storage extensions.
 *
 * An allowlist, not a blocklist. A blocklist is always one step behind the next
 * format that turns out to be able to carry a script, and who bears that is the
 * server also holding the salary data.
 *
 * The client's `content-type` is NOT trusted on its own — it only decides the
 * extension. The file's contents are checked against its magic bytes in
 * `sniffType`.
const ACCEPTED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const store = createBlobStore({
  envVar: 'DOCUMENT_STORAGE_DIR',
  fallbackDir: './.storage/employee-documents',
  extensions: Object.values(ACCEPTED),
  maxBytes: MAX_DOCUMENT_BYTES,
});

/**
 * Determines a file's type from its contents, not from its name.
 *
 * The file name and the `content-type` are both sent by the client, so both can
 * lie. A script named `ktp.pdf` sent with `content-type: application/pdf` would
 * pass any check that reads only metadata — and be stored on the server as a
 * document that looks legitimate.
 *
 * The magic bytes in the first few bytes cannot be faked without making the file
 * genuinely that type.
 */
export function sniffType(content: Buffer): string | null {
  if (content.length < 12) return null;

  // %PDF
  if (content.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  // JPEG: FF D8 FF
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    content.subarray(0, 4).toString('latin1') === 'RIFF' &&
    content.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export interface DocumentSummary {
  id: string;
  employeeId: string;
  kind: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string | null;
  /** True when `expiresAt` has passed. Computed, not stored. */
  expired: boolean;
  uploadedBy: string;
  createdAt: string;
  archivedAt: string | null;
}

function toSummary(row: {
  id: string;
  employeeId: string;
  kind: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date | null;
  uploadedBy: string;
  createdAt: Date;
  archivedAt: Date | null;
}): DocumentSummary {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    title: row.title,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() < Date.now(),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export async function listDocuments(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  options: { includeArchived?: boolean } = {},
): Promise<DocumentSummary[]> {
  const rows = await tx.employeeDocument.findMany({
    where: {
      tenantId,
      employeeId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  return rows.map(toSummary);
}

export interface UploadInput {
  employeeId: string;
  kind: DocumentKind;
  title: string;
  fileName: string;
  content: Buffer;
  expiresAt?: Date | null | undefined;
}

export async function uploadDocument(
  tx: TenantClient,
  tenantId: string,
  input: UploadInput,
  actorUserId: string,
  ip?: string | null,
): Promise<DocumentSummary> {
  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, tenantId },
    select: { id: true },
  });
  if (!employee) throw new DocumentError('Karyawan tidak ditemukan', 'not_found');

  if (input.content.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentError(
      `Ukuran berkas ${Math.round(input.content.length / 1024 / 1024)} MB melebihi batas ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
      'too_large',
    );
  }

  const mimeType = sniffType(input.content);
  const extension = mimeType ? ACCEPTED[mimeType] : undefined;

  if (!mimeType || !extension) {
    throw new DocumentError(
      'Jenis berkas tidak diterima. Unggah PDF, JPG, PNG, atau WebP. ' +
        'Berkas Word atau Excel harap disimpan sebagai PDF terlebih dahulu.',
      'invalid_type',
    );
  }

  const stored = await store.put(input.content, extension);

  const row = await tx.employeeDocument.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      kind: input.kind,
      title: input.title.trim(),
      // The original name is stored for display, NOT used as a path. A client's
      // file name can contain "../" and any character at all.
      fileName: input.fileName.trim().slice(0, 255),
      storageKey: stored.key,
      mimeType,
      sizeBytes: stored.bytes,
      expiresAt: input.expiresAt ?? null,
      uploadedBy: actorUserId,
    },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.document.uploaded',
    entityType: 'employee_document',
    entityId: row.id,
    actorUserId,
    after: { employeeId: input.employeeId, kind: input.kind, title: row.title },
    ip: ip ?? undefined,
  });

  return toSummary(row);
}

/**
 * Reads a document's contents, and records who read it at the same time.
 *
 * The logging and the read are combined into one function deliberately. If the
 * two were separate, there would be one call path that reads without logging —
 * and that is the path someone will use when they add a bulk export feature six
 * months from now.
 */
export async function readDocument(
  tx: TenantClient,
  tenantId: string,
  documentId: string,
  reader: { userId: string; isOwner: boolean },
): Promise<{ content: Buffer; document: DocumentSummary }> {
  const row = await tx.employeeDocument.findFirst({
    where: { id: documentId, tenantId },
  });
  if (!row) throw new DocumentError('Dokumen tidak ditemukan', 'not_found');
  if (row.archivedAt) throw new DocumentError('Dokumen sudah diarsipkan', 'archived');

  // An employee opening their own document is not logged. What this table exists
  // to answer is "who ELSE has opened it", and filling it with the owner's own
  // visits only makes that answer harder to read.
  if (!reader.isOwner) {
    await tx.documentAccessLog.create({
      data: {
        tenantId,
        documentId: row.id,
        employeeId: row.employeeId,
        accessedBy: reader.userId,
        action: 'VIEW',
      },
    });
  }

  try {
    return { content: await store.get(row.storageKey), document: toSummary(row) };
  } catch (error) {
    if (error instanceof BlobError) {
      throw new DocumentError(
        'Berkas dokumen ini tidak ditemukan di penyimpanan. Barisnya masih ada, tetapi isinya hilang.',
        'not_found',
      );
    }
    throw error;
  }
}

/**
 * Archives a document.
 *
 * Not deletion (rule M4 of document 09). The physical file is discarded — it is
 * personal data that is no longer needed — but its row survives, so the question
 * "who uploaded this ID card scan and when was it discarded" still has an
 * answer.
 */
export async function archiveDocument(
  tx: TenantClient,
  tenantId: string,
  documentId: string,
  actorUserId: string,
  ip?: string | null,
): Promise<void> {
  const row = await tx.employeeDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true, storageKey: true, employeeId: true, title: true, archivedAt: true },
  });
  if (!row) throw new DocumentError('Dokumen tidak ditemukan', 'not_found');
  if (row.archivedAt) return;

  // The file is deleted first, then its row is marked. The reverse order would
  // leave an orphan file if the process died in between.
  const outcome = await store.remove(row.storageKey);

  await tx.employeeDocument.update({
    where: { id: row.id },
    data: { archivedAt: new Date(), archivedBy: actorUserId },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.document.archived',
    entityType: 'employee_document',
    entityId: row.id,
    actorUserId,
    before: { employeeId: row.employeeId, title: row.title },
    after: { berkasDihapus: outcome.removed, berkasSudahTidakAda: outcome.alreadyGone },
    ip: ip ?? undefined,
  });
}

/** Documents expiring within the next so many days, for HR reminders. */
export async function expiringDocuments(
  tx: TenantClient,
  tenantId: string,
  withinDays: number,
): Promise<DocumentSummary[]> {
  const until = new Date(Date.now() + withinDays * 86_400_000);

  const rows = await tx.employeeDocument.findMany({
    where: {
      tenantId,
      archivedAt: null,
      expiresAt: { not: null, lte: until },
    },
    orderBy: [{ expiresAt: 'asc' }],
    take: 200,
  });

  return rows.map(toSummary);
}
