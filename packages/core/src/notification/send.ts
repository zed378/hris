import { withTenant, workerClient, Prisma, type TenantClient } from '@hrms/db';
import { emailTransport, type EmailMessage } from './transport.ts';
import {
  contractExpiringEmail,
  documentExpiringEmail,
  invitationEmail,
  passwordResetEmail,
  type RenderedEmail,
} from './templates.ts';

/**
 * Pengiriman notifikasi dari event.
 *
 * Bentuk yang mengikat seluruh berkas ini adalah **klaim lebih dulu, kirim
 * kemudian**:
 *
 *   1. Sisipkan baris catatan berstatus PENDING dengan `dedupeKey`.
 *   2. Bila penyisipan ditolak constraint unique, peristiwa ini sudah pernah
 *      ditangani — berhenti, jangan kirim apa pun.
 *   3. Kirim.
 *   4. Perbarui status.
 *
 * Urutan itu bukan selera. Outbox menjamin at-least-once, sehingga konsumer yang
 * mati setelah mengirim tetapi sebelum meng-ack akan menerima pesan yang sama
 * lagi. Mengirim lebih dulu lalu mencatat berarti email kedua sudah terlanjur
 * sampai sebelum ada yang tahu.
 *
 * Kompromi yang diterima: bila proses mati di antara langkah 1 dan 3, email
 * tidak pernah terkirim dan baris PENDING tertinggal. Itu kegagalan yang
 * terlihat — baris PENDING lama dapat dipantau — sedangkan email ganda tidak
 * dapat ditarik kembali.
 */

export type NotifiableTopic =
  | 'auth.password.reset_requested'
  | 'iam.user.invited'
  | 'employee.contract.expiring'
  | 'employee.document.expiring';

export interface DeliveryResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

interface Plan {
  dedupeKey: string;
  recipient: string;
  email: RenderedEmail;
}

/**
 * Menyiapkan pesan dari sebuah event.
 *
 * Mengembalikan `null` bila event tidak menghasilkan email — misalnya pengingat
 * kontrak pada tenant yang belum memiliki satu pun penerima. Itu bukan galat.
 */
async function planDelivery(
  tx: TenantClient,
  tenantId: string,
  topic: NotifiableTopic,
  payload: Record<string, unknown>,
): Promise<Plan | null> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, code: true },
  });

  if (topic === 'auth.password.reset_requested') {
    const user = await tx.user.findUnique({
      where: { id: String(payload['userId']) },
      select: { email: true, fullName: true },
    });
    if (!user) return null;

    return {
      // Token-nya sendiri yang menjadi kunci: satu permintaan reset menghasilkan
      // tepat satu token, dan permintaan kedua menerbitkan token baru sekaligus
      // membatalkan yang lama.
      dedupeKey: `password_reset:${String(payload['token']).slice(0, 32)}`,
      recipient: user.email,
      email: passwordResetEmail({
        tenantName: tenant.name,
        fullName: user.fullName,
        token: String(payload['token']),
        expiresAt: String(payload['expiresAt']),
      }),
    };
  }

  if (topic === 'iam.user.invited') {
    const user = await tx.user.findUnique({
      where: { id: String(payload['userId']) },
      select: { email: true, fullName: true },
    });
    if (!user) return null;

    return {
      dedupeKey: `invitation:${String(payload['token']).slice(0, 32)}`,
      recipient: user.email,
      email: invitationEmail({
        tenantName: tenant.name,
        tenantCode: tenant.code,
        fullName: user.fullName,
        token: String(payload['token']),
        expiresAt: String(payload['expiresAt']),
      }),
    };
  }

  if (topic === 'employee.document.expiring') {
    // Ditujukan ke pemegang izin mengelola dokumen, bukan ke karyawannya.
    // Yang dapat memperpanjang KITAS bukan orang yang KITAS-nya habis.
    const recipients = await hrRecipients(tx, tenantId, 'employee.document.manage');
    if (recipients.length === 0) return null;

    return {
      // Dokumen + ambang, bukan tanggal — alasannya sama dengan kontrak:
      // pemindaian harian akan menemukan dokumen yang sama setiap hari.
      dedupeKey: `document_expiring:${String(payload['documentId'])}:${String(payload['threshold'])}`,
      recipient: recipients.join(', '),
      email: documentExpiringEmail({
        tenantName: tenant.name,
        employeeName: String(payload['employeeName']),
        employeeNumber: String(payload['employeeNumber']),
        kind: String(payload['kind']),
        title: String(payload['title']),
        expiresAt: String(payload['expiresAt']),
        daysLeft: Number(payload['daysLeft']),
        threshold: String(payload['threshold']),
      }),
    };
  }

  // Pengingat kontrak ditujukan ke HR, bukan ke karyawan yang bersangkutan.
  // Yang perlu bertindak adalah pemegang izin mengelola kontrak.
  const recipients = await hrRecipients(tx, tenantId, 'employee.contract.manage');

  if (recipients.length === 0) return null;

  return {
    // Kontrak + ambang, bukan tanggal. Pemindaian berjalan harian dan kontrak
    // yang sama akan terus masuk rentang; kunci inilah yang membuat HR menerima
    // satu pengingat per ambang, bukan satu per hari selama tiga bulan.
    dedupeKey: `contract_expiring:${String(payload['contractId'])}:${String(payload['threshold'])}`,
    recipient: recipients.join(', '),
    email: contractExpiringEmail({
      tenantName: tenant.name,
      employeeName: String(payload['employeeName']),
      employeeNumber: String(payload['employeeNumber']),
      contractNumber: String(payload['contractNumber']),
      contractType: String(payload['type']),
      endDate: String(payload['endDate']),
      daysLeft: Number(payload['daysLeft']),
      threshold: String(payload['threshold']),
    }),
  };
}

/**
 * Alamat email pemegang sebuah izin di tenant ini.
 *
 * Dibatasi lima. Pengingat yang dikirim ke tiga puluh orang bukan pengingat;
 * ia pengumuman, dan tidak ada satu pun dari tiga puluh orang itu yang merasa
 * dirinyalah yang harus bertindak.
 */
async function hrRecipients(
  tx: TenantClient,
  tenantId: string,
  permissionCode: string,
): Promise<string[]> {
  const users = await tx.user.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      roles: { some: { role: { permissions: { some: { permissionCode } } } } },
    },
    select: { email: true },
    take: 5,
  });
  return users.map((u) => u.email);
}

export async function deliverNotification(
  tenantId: string,
  topic: NotifiableTopic,
  payload: Record<string, unknown>,
): Promise<DeliveryResult> {
  const client = workerClient();

  const claim = await withTenant(
    tenantId,
    async (tx): Promise<{ plan: Plan; logId: string } | { skipped: string }> => {
      const plan = await planDelivery(tx, tenantId, topic, payload);
      if (!plan) return { skipped: 'tidak ada penerima' };

      try {
        const log = await tx.notificationLog.create({
          data: {
            tenantId,
            channel: 'EMAIL',
            topic,
            dedupeKey: plan.dedupeKey,
            recipient: plan.recipient,
            subject: plan.email.subject,
            status: 'PENDING',
            attempts: 1,
          },
          select: { id: true },
        });
        return { plan, logId: log.id };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return { skipped: 'already sent' };
        }
        throw error;
      }
    },
    { client },
  );

  if ('skipped' in claim) return { status: 'skipped', reason: claim.skipped };

  const message: EmailMessage = {
    to: claim.plan.recipient,
    subject: claim.plan.email.subject,
    text: claim.plan.email.text,
  };

  try {
    await emailTransport().send(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await withTenant(
      tenantId,
      (tx) =>
        tx.notificationLog.update({
          where: { id: claim.logId },
          data: { status: 'FAILED', lastError: reason.slice(0, 500) },
        }),
      { client },
    );
    return { status: 'failed', reason };
  }

  await withTenant(
    tenantId,
    (tx) =>
      tx.notificationLog.update({
        where: { id: claim.logId },
        data: { status: 'SENT', sentAt: new Date() },
      }),
    { client },
  );

  return { status: 'sent' };
}
