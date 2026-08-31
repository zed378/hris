import { writeAudit, type TenantClient } from '@hrms/db';
import { createBlobStore, BlobError } from '../storage/index.ts';
import { LeaveError } from './balance.ts';

/**
 * Lampiran pengajuan cuti sebagai berkas (dokumen 03 §4.4).
 *
 * `leave_types.requires_attachment` ada sejak modul cuti dibangun, dan seed
 * menyalakannya untuk Cuti Sakit dan Cuti Melahirkan. Pemeriksaannya berbunyi:
 *
 *     if (type.requiresAttachment && !input.attachmentKey) tolak
 *
 * `attachmentKey` adalah kolom teks bebas, dan layarnya menampilkan kotak isian
 * bertuliskan "Nomor atau nama berkas surat dokter". Artinya syarat "wajib
 * melampirkan surat dokter" **dipenuhi dengan mengetik kata 'ada'.**
 *
 * Untuk cuti sakit, surat dokter itulah satu-satunya hal yang membedakan cuti
 * berbayar dari mangkir. Syarat yang menerima sembarang teks bukan syarat; ia
 * kotak isian yang membuat semua pihak — karyawan, atasan, HR, dan auditor —
 * mengira ada bukti yang tersimpan.
 *
 * ## Bentuknya
 *
 * Unggah mendahului pengajuan, karena pengunggahnya belum tahu id pengajuannya.
 * Karena itu lampiran lahir **yatim** dan diadopsi saat pengajuan dibuat. Yang
 * tetap yatim adalah berkas yang diunggah lalu pengajuannya tidak jadi dikirim,
 * dan job berkala membersihkannya — data pribadi yang tidak terhubung ke apa pun
 * tidak punya alasan bertahan.
 */

/** Surat dokter dipindai ponsel; 5 MB cukup, dan lebih dari itu biasanya salah unggah. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Jenis yang diterima, beserta ekstensi penyimpanannya.
 *
 * Daftar putih, dan isinya diperiksa dari angka ajaibnya — bukan dari nama
 * berkas maupun `content-type`, yang keduanya dikirim klien dan karenanya
 * keduanya dapat berbohong.
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

/** Menentukan jenis berkas dari isinya. */
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
      // Nama asli disimpan untuk ditampilkan, TIDAK untuk membentuk jalur
      // berkasnya. Nama berkas berasal dari klien; memakainya sebagai jalur
      // berarti "../../etc/passwd" menjadi lokasi penyimpanan yang sah.
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
 * Memeriksa bahwa sebuah kunci lampiran benar milik karyawan ini dan masih yatim.
 *
 * Dipanggil `submitRequest`. Tiga hal yang diperiksanya, dan ketiganya perlu:
 *
 *   - **Ada.** Kunci karangan tidak boleh memenuhi syarat lampiran.
 *   - **Milik karyawan ini.** Tanpa pemeriksaan ini, seorang karyawan dapat
 *     memakai ulang kunci surat dokter rekannya — kunci itu memang acak, tetapi
 *     ia pernah lewat di layar orang lain.
 *   - **Belum dipakai pengajuan lain.** Satu surat dokter untuk satu pengajuan;
 *     memakai ulang lampiran yang sama untuk cuti sakit bulan berikutnya adalah
 *     hal yang akan dicoba orang.
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
    // Pesannya sengaja sama dengan "tidak ditemukan": membedakannya memberi
    // tahu pemanggil bahwa kunci itu ada dan milik orang lain.
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

/** Menghubungkan lampiran ke pengajuan yang baru dibuat. */
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

/** Umur lampiran yatim sebelum dibuang. Cukup untuk mengunggah lalu mengisi formulirnya. */
export const ORPHAN_MAX_AGE_HOURS = 24;

/**
 * Membuang lampiran yang diunggah tetapi pengajuannya tidak jadi dikirim.
 *
 * Berkas dihapus lebih dulu, baru barisnya — urutan yang sama dengan retensi
 * foto presensi, dan alasannya sama: urutan sebaliknya meninggalkan berkas yatim
 * yang tidak lagi terhubung ke catatan apa pun, dan karenanya tidak akan pernah
 * terhapus oleh putaran berikutnya.
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
      // Barisnya SENGAJA dibiarkan. Selama ia bertahan, putaran berikutnya akan
      // menemukan berkas ini lagi.
      result.failed += 1;
      continue;
    }

    await tx.leaveAttachment.delete({ where: { id: orphan.id } });
    if (outcome.removed) result.deleted += 1;
    else result.alreadyGone += 1;
  }

  return result;
}
