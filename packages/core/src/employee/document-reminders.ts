import { EventTopic } from '@hrms/contracts';
import { publishEvent, type TenantClient } from '@hrms/db';
import type { ReminderScanResult, ReminderThreshold } from './contracts.ts';

/**
 * Pengingat dokumen karyawan yang akan kedaluwarsa (dokumen 09 §6).
 *
 * `employee_documents.expires_at` ada sejak modul dokumen dibangun, dengan
 * komentar "untuk dokumen yang memang berumur — KITAS, SIM, kontrak". HR
 * mengisinya. Lalu tanggalnya lewat, dan tidak terjadi apa-apa: tidak ada satu
 * pun jalur kode yang pernah membaca kolom itu.
 *
 * Yang lewat bukan sekadar tanggal di basis data:
 *
 *   - **KITAS kedaluwarsa** = tenaga kerja asing bekerja tanpa izin. Pidana bagi
 *     perusahaan menurut UU 6/2011 tentang Keimigrasian, deportasi bagi orangnya.
 *   - **SIM kedaluwarsa** = sopir perusahaan mengemudi tanpa izin, dan asuransi
 *     kendaraan batal pada kecelakaan pertama.
 *
 * Keduanya baru ketahuan saat ada yang memeriksa — dan yang memeriksa biasanya
 * bukan HR.
 *
 * Bentuknya sengaja sama persis dengan `scanContractReminders`, sampai ke nama
 * ambangnya. Dua job yang mengerjakan hal serupa dengan bentuk berbeda adalah
 * dua job yang harus dipahami terpisah, dan yang kedua akan salah.
 */

/** Dokumen yang tidak perlu diingatkan meski punya tanggal kedaluwarsa. */
const IGNORED_KINDS = new Set(['KONTRAK']);

export async function scanDocumentReminders(
  tx: TenantClient,
  tenantId: string,
): Promise<ReminderScanResult> {
  const today = startOfDay(new Date());
  let reminded = 0;

  const documents = await tx.employeeDocument.findMany({
    where: {
      tenantId,
      expiresAt: { not: null, gte: new Date(today.getTime() - 30 * 86_400_000) },
      // Dokumen yang sudah diarsipkan tidak diingatkan. Pengarsipan adalah cara
      // HR menyatakan dokumen itu tidak lagi berlaku — mengingatkannya berarti
      // meminta tindakan atas keputusan yang sudah diambil.
      archivedAt: null,
    },
    select: {
      id: true,
      kind: true,
      title: true,
      expiresAt: true,
      employeeId: true,
      reminders: { select: { threshold: true } },
    },
  });

  // Karyawan dibaca terpisah, bukan lewat relasi.
  //
  // `employee_documents.employee_id` tidak punya foreign key di basis data —
  // keadaan yang ditemukan saat menulis berkas ini, bukan yang dirancang — dan
  // Prisma karenanya tidak mengenal relasinya. Menambahkan FK itu perubahan
  // skema tersendiri yang perlu memeriksa lebih dulu apakah ada baris yatim,
  // dan menyelipkannya ke dalam perubahan ini berarti dua hal berbeda dalam satu
  // migrasi.
  //
  // Karyawan yang TIDAK ditemukan dilewati. Dokumen milik orang yang sudah
  // keluar atau yang barisnya hilang tidak menghasilkan pengingat kepada siapa
  // pun — dan diamnya di sini benar: tidak ada tindakan yang dapat diambil atas
  // KITAS orang yang sudah tidak bekerja di sini.
  const employees = await tx.employee.findMany({
    where: {
      tenantId,
      id: { in: [...new Set(documents.map((d) => d.employeeId))] },
      status: { in: ['ACTIVE', 'PROBATION'] },
    },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  for (const document of documents) {
    const employee = byId.get(document.employeeId);
    if (!employee) continue;

    // Kontrak punya jalur pengingatnya sendiri, dengan peringatan hukum yang
    // berbeda (PKWT yang lewat berubah menjadi PKWTT demi hukum). Mengirim
    // keduanya berarti HR menerima dua email untuk satu kejadian, dan yang
    // kedua isinya lebih lemah.
    if (IGNORED_KINDS.has(document.kind.toUpperCase())) continue;

    const daysLeft = Math.round(
      (startOfDay(document.expiresAt!).getTime() - today.getTime()) / 86_400_000,
    );
    const sent = new Set(document.reminders.map((r) => r.threshold));

    // Ambang tertinggi yang sudah terlewati, bukan semuanya. Dokumen yang baru
    // diunggah ketika sisa 20 hari tidak perlu menerima tiga pengingat sekaligus.
    const due: ReminderThreshold | null =
      daysLeft < 0 ? 'EXPIRED'
      : daysLeft <= 7 ? 'D7'
      : daysLeft <= 30 ? 'D30'
      : daysLeft <= 90 ? 'D90'
      : null;

    if (!due || sent.has(due)) continue;

    try {
      await tx.documentReminder.create({
        data: { tenantId, documentId: document.id, threshold: due },
      });
    } catch {
      // Constraint unique menolak duplikat. Dua job yang berjalan bersamaan —
      // hal yang terjadi saat deploy bertepatan dengan jadwal — akan membuat
      // salah satunya gagal di sini, dan itu perilaku yang benar.
      continue;
    }

    await publishEvent(tx, tenantId, {
      topic: EventTopic.DOCUMENT_EXPIRING,
      payload: {
        tenantId,
        documentId: document.id,
        kind: document.kind,
        title: document.title,
        expiresAt: document.expiresAt!.toISOString().slice(0, 10),
        daysLeft,
        threshold: due,
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        employeeName: employee.fullName,
      },
    });

    reminded += 1;
  }

  return { scanned: documents.length, reminded };
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
