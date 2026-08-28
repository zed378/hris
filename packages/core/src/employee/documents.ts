import { type DocumentKind } from '@hrms/contracts';
import { writeAudit, type TenantClient } from '@hrms/db';
import { createBlobStore, BlobError } from '../storage/index.ts';

/**
 * Dokumen karyawan (PLAN/12 F2).
 *
 * Yang disimpan di sini bukan lampiran biasa: pindaian KTP, kartu keluarga,
 * ijazah, surat kontrak. Seluruhnya data pribadi menurut UU PDP No. 27/2022,
 * dan sebagiannya cukup untuk membuka rekening bank atas nama orang lain.
 *
 * Tiga sifat yang mengikuti dari kenyataan itu:
 *
 *   1. **Jenis berkas dibatasi.** Hanya PDF dan gambar. Menerima berkas
 *      sembarang berarti menyimpan lampiran yang dapat dieksekusi di server
 *      yang sama dengan data gaji.
 *   2. **Pembacaan dicatat.** Sejajar dengan foto presensi: pertanyaan "siapa
 *      saja yang pernah membuka pindaian KTP saya" harus dapat dijawab.
 *   3. **Tidak ada penghapusan, hanya pengarsipan.** Aturan M4 dokumen 09.
 *      Berkas fisiknya boleh hilang; barisnya bertahan supaya riwayat
 *      "pernah ada dokumen ini, diunggah siapa" tidak ikut hilang.
 */

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'invalid_type' | 'too_large' | 'archived',
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

// Daftar jenisnya tinggal di `@hrms/contracts` supaya layar unggah — komponen
// klien — dapat memakainya tanpa menarik Prisma ke dalam bundel peramban.
// Di-ekspor ulang di sini agar pemanggil di modul karyawan tidak perlu tahu itu.
export { DOCUMENT_KINDS, type DocumentKind } from '@hrms/contracts';


/** Pindaian KTP resolusi wajar ≈ 1-3 MB; ijazah berwarna bisa 8 MB. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Jenis berkas yang diterima, beserta ekstensi penyimpanannya.
 *
 * Daftar putih, bukan daftar hitam. Daftar hitam selalu tertinggal satu langkah
 * dari format berikutnya yang ternyata dapat membawa skrip, dan yang menanggung
 * akibatnya adalah server yang juga memegang data gaji.
 *
 * `content-type` dari klien TIDAK dipercaya sendirian — ia hanya menentukan
 * ekstensi. Isi berkasnya diperiksa terhadap angka ajaibnya di `sniffType`.
 */
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
 * Menentukan jenis berkas dari isinya, bukan dari namanya.
 *
 * Nama berkas dan `content-type` sama-sama dikirim klien, sehingga keduanya
 * dapat berbohong. Sebuah skrip bernama `ktp.pdf` yang dikirim dengan
 * `content-type: application/pdf` akan lolos pemeriksaan apa pun yang hanya
 * membaca metadata — dan tersimpan di server sebagai dokumen yang tampak sah.
 *
 * Angka ajaib di beberapa byte pertama tidak dapat dipalsukan tanpa membuat
 * berkasnya benar-benar menjadi jenis itu.
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
  /** True bila `expiresAt` sudah lewat. Dihitung, bukan disimpan. */
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
      // Nama asli disimpan untuk ditampilkan, TIDAK dipakai sebagai path.
      // Nama berkas dari klien dapat memuat "../" dan karakter apa pun.
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
 * Membaca isi dokumen, sekaligus mencatat siapa yang membacanya.
 *
 * Pencatatan dan pembacaan digabung dalam satu fungsi dengan sengaja. Bila
 * keduanya terpisah, akan ada satu jalur pemanggilan yang membaca tanpa
 * mencatat — dan jalur itulah yang akan dipakai ketika seseorang menambahkan
 * fitur ekspor massal enam bulan dari sekarang.
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

  // Karyawan yang membuka dokumennya sendiri tidak dicatat. Yang hendak dijawab
  // tabel ini adalah "siapa LAGI yang pernah membukanya", dan mengisinya dengan
  // kunjungan pemiliknya sendiri hanya membuat jawabannya sulit dibaca.
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
 * Mengarsipkan dokumen.
 *
 * Bukan menghapus (aturan M4 dokumen 09). Berkas fisiknya dibuang — ia data
 * pribadi yang tidak lagi diperlukan — tetapi barisnya bertahan, sehingga
 * pertanyaan "siapa yang pernah mengunggah pindaian KTP ini dan kapan
 * dibuang" tetap punya jawaban.
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

  // Berkas dihapus lebih dulu, baru barisnya ditandai. Urutan sebaliknya akan
  // meninggalkan berkas yatim bila proses mati di antaranya.
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

/** Dokumen yang kedaluwarsa dalam sekian hari ke depan, untuk pengingat HR. */
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
