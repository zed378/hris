import { writeAudit, type TenantClient } from '@hrms/db';
import { createBlobStore, BlobError } from '../storage/index.ts';
import { LeaveError } from './balance.ts';

/**
 * Leave request attachments as files (document 03 §4.4).
 *
 * `leave_types.requires_attachment` has existed since the leave module was
 * built, and the seed turns it on for Sick Leave and Maternity Leave. Its check
 * read:
 *
 *     if (type.requiresAttachment && !input.attachmentKey) refuse
 *
 * `attachmentKey` is a free-text column, and its screen showed an input box
 * labelled "Number or name of the doctor's note file". Which means the
 * requirement "a doctor's note is mandatory" was **satisfied by typing 'ada'.**
 *
 * For sick leave, that doctor's note is the only thing separating paid leave
 * from absence. A requirement that accepts arbitrary text is not a requirement;
 * it is an input box that makes everyone — the employee, their manager, HR, and
 * an auditor — believe evidence is stored.
 *
 * ## Its shape
 *
 * The upload precedes the request, because the uploader does not know its
 * request id yet. So an attachment is born an **orphan** and is adopted when the
 * request is created. What stays an orphan is a file uploaded whose request was
 * never submitted, and a periodic job clears those — personal data connected to
 * nothing has no reason to survive.
 */

/** A doctor's note scanned by phone; 5 MB is enough, and more usually means a wrong upload. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The accepted types, with their storage extensions.
 *
 * An allowlist, and the contents are checked against their magic bytes — not
 * against the file name or the `content-type`, both of which are sent by the
 * client and can therefore both lie.
 */
const ACCEPTED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const store = createBlobStore({
  envVar: 'LEAVE_ATTACHMENT_STORAGE_DIR',
  fallbackDir: './.storage/leave-attachments',
  extensions: Object.values(ACCEPTED),
  maxBytes: MAX_ATTACHMENT_BYTES,
});

/** Determines a file's type from its contents. */
function sniffType(content: Buffer): string | null {
  if (content.length < 12) return null;

  if (content.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (
    content.subarray(0, 4).toString('latin1') === 'RIFF' &&
    content.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export interface AttachmentView {
  id: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export async function uploadAttachment(
  tx: TenantClient,
  tenantId: string,
  input: { employeeId: string; fileName: string; content: Buffer },
  actorUserId: string,
): Promise<AttachmentView> {
  if (input.content.length > MAX_ATTACHMENT_BYTES) {
    throw new LeaveError(
      `Ukuran berkas ${Math.round(input.content.length / 1024 / 1024)} MB melebihi batas ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      'invalid_state',
    );
  }

  const mimeType = sniffType(input.content);
  const extension = mimeType ? ACCEPTED[mimeType] : undefined;

  if (!mimeType || !extension) {
    throw new LeaveError(
      'Jenis berkas tidak diterima. Unggah PDF, JPG, PNG, atau WebP. ' +
        'Isi berkasnya diperiksa, bukan namanya — mengganti nama tidak mengubah hasilnya.',
      'invalid_state',
    );
  }

  const stored = await store.put(input.content, extension);

  const row = await tx.leaveAttachment.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      storageKey: stored.key,
      // The original name is stored for display, NOT to build its file path. A
      // file name comes from the client; using it as a path would make
      // "../../etc/passwd" a valid storage location.
      fileName: input.fileName.slice(0, 200),
      mimeType,
      sizeBytes: input.content.length,
      uploadedBy: actorUserId,
    },
    select: { id: true, storageKey: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
  });

  await writeAudit(tx, tenantId, {
    action: 'leave.attachment.uploaded',
    entityType: 'leave_attachment',
    entityId: row.id,
    actorUserId,
    after: { employeeId: input.employeeId, fileName: row.fileName, sizeBytes: row.sizeBytes },
  });

  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * Checks that an attachment key really belongs to this employee and is still an orphan.
 *
 * Called by `submitRequest`. It checks three things, and all three are needed:
 *
 *   - **It exists.** A fabricated key must not satisfy an attachment requirement.
 *   - **It belongs to this employee.** Without this check, an employee could
 *     reuse a colleague's doctor's note key — the key is random, but it has
 *     passed across someone else's screen.
 *   - **It is not used by another request.** One doctor's note per request;
 *     reusing the same attachment for next month's sick leave is something
 *     people will try.
 */
export async function claimAttachment(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  storageKey: string,
): Promise<{ id: string }> {
  const row = await tx.leaveAttachment.findFirst({
    where: { tenantId, storageKey },
    select: { id: true, employeeId: true, requestId: true },
  });

  if (!row) {
    throw new LeaveError(
      'Lampiran tidak ditemukan. Unggah berkasnya lebih dulu.',
      'not_found',
    );
  }
  if (row.employeeId !== employeeId) {
    // Its message is deliberately the same as "not found": distinguishing them
    // tells the caller that the key exists and belongs to someone else.
    throw new LeaveError(
      'Lampiran tidak ditemukan. Unggah berkasnya lebih dulu.',
      'not_found',
    );
  }
  if (row.requestId) {
    throw new LeaveError(
      'Lampiran ini sudah dipakai pengajuan lain. Unggah berkasnya lagi.',
      'invalid_state',
    );
  }

  return { id: row.id };
}

/** Links an attachment to the request that was just created. */
export async function attachToRequest(
  tx: TenantClient,
  tenantId: string,
  attachmentId: string,
  requestId: string,
): Promise<void> {
  await tx.leaveAttachment.updateMany({
    where: { id: attachmentId, tenantId, requestId: null },
    data: { requestId },
  });
}

export async function readAttachment(
  tx: TenantClient,
  tenantId: string,
  storageKey: string,
): Promise<{ content: Buffer; view: AttachmentView; employeeId: string } | null> {
  const row = await tx.leaveAttachment.findFirst({
    where: { tenantId, storageKey },
    select: {
      id: true,
      employeeId: true,
      storageKey: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
  });
  if (!row) return null;

  try {
    const content = await store.get(row.storageKey);
    return {
      content,
      employeeId: row.employeeId,
      view: { ...row, createdAt: row.createdAt.toISOString() },
    };
  } catch (error) {
    if (error instanceof BlobError) return null;
    throw error;
  }
}

export interface OrphanCleanupResult {
  deleted: number;
  alreadyGone: number;
  failed: number;
}

/** How long an orphan attachment lives. Enough time to upload and then fill in the form. */
export const ORPHAN_MAX_AGE_HOURS = 24;

/**
 * Discards an attachment uploaded whose request was never submitted.
 *
 * The file is deleted first, then its row — the same order as attendance photo
 * retention, and for the same reason: the reverse order leaves an orphan file
 * connected to no record, and therefore one that the next round will never
 * delete.
 */
export async function cleanupOrphanAttachments(
  tx: TenantClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<OrphanCleanupResult> {
  const cutoff = new Date(now.getTime() - ORPHAN_MAX_AGE_HOURS * 3_600_000);

  const orphans = await tx.leaveAttachment.findMany({
    where: { tenantId, requestId: null, createdAt: { lt: cutoff } },
    take: 500,
    select: { id: true, storageKey: true },
  });

  const result: OrphanCleanupResult = { deleted: 0, alreadyGone: 0, failed: 0 };

  for (const orphan of orphans) {
    let outcome;
    try {
      outcome = await store.remove(orphan.storageKey);
    } catch {
      // Its row is DELIBERATELY left. While it survives, the next round will find
      // this file again.
      result.failed += 1;
      continue;
    }

    await tx.leaveAttachment.delete({ where: { id: orphan.id } });
    if (outcome.removed) result.deleted += 1;
    else result.alreadyGone += 1;
  }

  return result;
}
