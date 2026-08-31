import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { sendPush } from '@hrms/core/notification';

/**
 * Memberi tahu karyawan bahwa cutinya sudah diputuskan.
 *
 * Ini notifikasi yang paling ditunggu di seluruh sistem: seseorang mengajukan
 * cuti, lalu memeriksa layar berulang kali sampai ada jawabannya. Sebelum ini
 * kedua topiknya di-`drain` — dicatat lalu dibuang — sehingga jawabannya hanya
 * terlihat oleh yang membuka aplikasinya sendiri.
 *
 * ## Isinya sengaja tipis
 *
 * Judul dan satu baris: keputusannya, jenis cutinya, tanggalnya. **Tidak ada
 * alasan pengajuan, tidak ada komentar penyetuju.** Notifikasi muncul di layar
 * terkunci yang dapat dilihat siapa pun yang kebetulan berada di dekat
 * perangkat itu, dan enkripsi push tidak menolong di sana — "cuti sakit Anda
 * ditolak karena surat dokternya tidak sah" adalah kalimat yang tidak
 * seharusnya terbaca orang lain di angkutan umum.
 *
 * ## Push adalah tambahan, bukan pengganti
 *
 * Web Push tidak berfungsi di iOS kecuali PWA sudah dipasang ke Layar Utama
 * (dokumen 04 §R52), dan sebagian besar pengguna tidak memasangnya. Karena itu
 * kegagalan di sini **tidak dianggap kegagalan pemberitahuan** — layar cuti
 * tetap menampilkan keputusannya, dan itulah jalur yang dijamin.
 */

export interface LeaveNotifyPayload {
  requestId?: string;
  requestNumber?: string;
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  totalDays?: number;
}

export async function notifyLeaveDecision(
  tenantId: string,
  payload: LeaveNotifyPayload,
  approved: boolean,
): Promise<{ sent: number; pruned: number }> {
  const employeeId = payload.employeeId;
  if (!employeeId) return { sent: 0, pruned: 0 };

  return withTenant(
    tenantId,
    async (tx) => {
      // Karyawan → pengguna lewat email, referensi lunak yang sama dengan yang
      // dipakai presensi (PLAN/01 §4.2). Karyawan tanpa akun tidak menerima
      // push, dan itu keadaan normal — ia melihat keputusannya saat HR
      // memberitahunya, seperti sebelum ada sistem ini.
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, tenantId },
        select: { email: true },
      });
      if (!employee?.email) return { sent: 0, pruned: 0 };

      const user = await tx.user.findFirst({
        where: { tenantId, email: employee.email, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!user) return { sent: 0, pruned: 0 };

      const tanggal =
        payload.startDate === payload.endDate
          ? payload.startDate
          : `${payload.startDate} s.d. ${payload.endDate}`;

      const result = await sendPush(tx, tenantId, user.id, {
        title: approved ? 'Cuti Anda disetujui' : 'Cuti Anda ditolak',
        body: `${tanggal} · ${payload.totalDays ?? 0} hari`,
        // Ber-tag pengajuan: percobaan kedua untuk keputusan yang SAMA menimpa
        // notifikasi pertama alih-alih menumpuk di atasnya.
        tag: `leave:${payload.requestId ?? 'x'}`,
        url: '/leave/me',
      });

      return { sent: result.sent, pruned: result.pruned };
    },
    { client: workerClient() },
  ).catch((error: unknown) => {
    // Kegagalan push bukan kegagalan pemberitahuan. Dicatat, lalu dilupakan.
    log.warn({ scope: 'leave-notify', tenantId, employeeId, error });
    return { sent: 0, pruned: 0 };
  });
}
