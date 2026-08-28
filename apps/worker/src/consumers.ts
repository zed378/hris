import { log } from '@hrms/observability';
import { runPayrollCalculation } from './payroll-run.ts';
import { EventTopic } from '@hrms/contracts';
import { deliverNotification, type NotifiableTopic } from '@hrms/core/notification';
import type { OutboxEnvelope } from './outbox-pump.ts';

/**
 * Katalog konsumen — satu keputusan untuk setiap topik event.
 *
 * Bentuknya `Record<EventTopic, …>` dengan sengaja: TypeScript menolak
 * mengompilasi berkas ini bila sebuah topik baru ditambahkan ke katalog event
 * tanpa keputusan di sini. Yang dicegah bukan lupa menulis konsumen, melainkan
 * lupa MEMUTUSKAN — dan keduanya berbeda hasilnya.
 *
 * Topik tanpa konsumen tidak menghasilkan galat apa pun. Antreannya ada, pesan
 * masuk, dan pekerjaannya duduk di status `created` sampai retensi pg-boss
 * mengarsipkannya. Tidak ada yang gagal, tidak ada yang memberi tahu, dan event
 * itu sekadar tidak pernah terjadi bagi siapa pun yang menunggunya.
 *
 * Karena itu `drain` harus ditulis eksplisit beserta alasannya. "Belum ada
 * efeknya" adalah keputusan yang sah; yang tidak sah adalah tidak terlihat
 * bahwa keputusan itu pernah diambil.
 */

export type Consumer =
  | { kind: 'handle'; run: (envelope: OutboxEnvelope) => Promise<void> }
  | { kind: 'drain'; reason: string };

/** Topik yang berubah menjadi email. Idempotensinya ada pada `notification_logs.dedupeKey`. */
function notify(topic: NotifiableTopic): Consumer {
  return {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const result = await deliverNotification(tenantId, topic, payload);
      if (result.status !== 'skipped') {
        // `correlationId` diteruskan dari amplop outbox — inilah sambungan yang
        // membuat jejak satu permintaan utuh melintasi batas antrean. Tanpa ini,
        // log worker adalah pulau yang tidak dapat dihubungkan ke permintaan
        // mana pun.
        log.info({ scope: 'notification', topic, correlationId: correlationId ?? undefined, ...result });
      }
    },
  };
}

export const CONSUMERS: Record<EventTopic, Consumer> = {
  [EventTopic.PASSWORD_RESET_REQUESTED]: notify('auth.password.reset_requested'),
  [EventTopic.USER_INVITED]: notify('iam.user.invited'),
  [EventTopic.CONTRACT_EXPIRING]: notify('employee.contract.expiring'),
  [EventTopic.DOCUMENT_EXPIRING]: notify('employee.document.expiring'),

  /**
   * Perhitungan payroll.
   *
   * Satu-satunya konsumen yang mengerjakan pekerjaan berat, bukan mengirim
   * pesan. Alasannya ada di `payroll-run.ts`: perhitungan seribu karyawan tidak
   * dapat selesai di dalam transaksi permintaan HTTP, dan yang terjadi bukan
   * "lambat" melainkan transaksi yang dibatalkan sehingga seluruh slip yang
   * sudah dihitung hilang.
   *
   * Galat SENGAJA dilempar kembali, tidak ditelan seperti konsumen lain.
   * pg-boss akan mencoba ulang, dan mencoba ulang di sini aman justru karena
   * potongan yang sudah selesai ter-commit: percobaan berikutnya melanjutkan,
   * bukan mengulang. Menelannya berarti run tertinggal setengah jadi tanpa ada
   * yang mencoba menyelesaikannya.
   */
  [EventTopic.PAYROLL_RUN_REQUESTED]: {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const { runId, actorUserId } = payload as { runId: string; actorUserId: string };
      const result = await runPayrollCalculation(tenantId, runId, actorUserId);
      log.info({ scope: 'payroll-run', correlationId: correlationId ?? undefined, tenantId, ...result });
    },
  },

  /**
   * Presensi yang ditandai untuk ditinjau.
   *
   * Mencatat saja untuk sekarang: antrean tinjauan HR dibaca langsung dari basis
   * data, bukan dari event. Yang belum ada adalah dorongan realtime ke dasbor HR
   * (Fase 3, SSE) — dan ketika ia dibangun, tempatnya di sini.
   */
  [EventTopic.PUNCH_FLAGGED]: {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const { punchId, trustScore, flags } = payload as {
        punchId?: string;
        trustScore?: number;
        flags?: string[];
      };
      log.info({
        scope: 'punch-flagged',
        correlationId: correlationId ?? undefined,
        tenantId,
        punchId,
        trustScore,
        flags,
      });
    },
  },

  /**
   * Cuti disetujui — presensi harus tahu.
   *
   * Hari bercuti tidak boleh dihitung alfa (lingkup F4). Kalkulasi harian
   * membaca cuti langsung dari basis data, sehingga event ini belum punya efek;
   * yang belum ada adalah pemicu hitung ulang otomatis untuk rentang cutinya.
   */
  [EventTopic.LEAVE_REQUEST_APPROVED]: {
    kind: 'drain',
    reason: 'hitung ulang rekap otomatis untuk rentang cuti, menyusul',
  },
  [EventTopic.LEAVE_REQUEST_REJECTED]: { kind: 'drain', reason: 'pemberitahuan penolakan, F4 lanjutan' },
  [EventTopic.LEAVE_REQUEST_SUBMITTED]: {
    kind: 'drain',
    reason: 'inbox approver realtime, F4 lanjutan',
  },
  [EventTopic.LEAVE_BALANCE_CHANGED]: { kind: 'drain', reason: 'widget saldo di dasbor, F6' },

  // Aliran audit dan metrik. Semuanya sudah tercatat di basis data pada
  // transaksi yang sama; event-nya ada untuk konsumen yang belum dibangun.
  [EventTopic.TENANT_PROVISIONED]: { kind: 'drain', reason: 'onboarding otomatis, Fase 6' },
  [EventTopic.TENANT_MODULE_ENABLED]: { kind: 'drain', reason: 'penagihan berbasis modul, Fase 6' },
  [EventTopic.TENANT_MODULE_DISABLED]: { kind: 'drain', reason: 'penagihan berbasis modul, Fase 6' },
  [EventTopic.TENANT_SUSPENDED]: { kind: 'drain', reason: 'pemberitahuan penangguhan, Fase 6' },

  [EventTopic.USER_LOGGED_IN]: { kind: 'drain', reason: 'metrik kesehatan tenant, Fase 6' },
  [EventTopic.USER_LOGIN_FAILED]: { kind: 'drain', reason: 'deteksi anomali masuk, Fase 6' },
  [EventTopic.SESSION_REVOKED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },
  [EventTopic.TOKEN_REUSE_DETECTED]: { kind: 'drain', reason: 'peringatan keamanan, Fase 6' },

  [EventTopic.ACCESS_CHANGED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },
  [EventTopic.ROLE_ASSIGNED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },

  [EventTopic.EMPLOYEE_CREATED]: { kind: 'drain', reason: 'penyediaan akun otomatis, Fase 4' },
  [EventTopic.EMPLOYEE_IMPORT_COMMITTED]: { kind: 'drain', reason: 'ringkasan impor ke HR, Fase 4' },
};
