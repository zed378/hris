import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PgBoss } from 'pg-boss';
import { disconnectAll } from '@hrms/db';
import { EventTopic } from '@hrms/contracts';
import { countStuck, pumpOnce, type OutboxEnvelope } from './outbox-pump.ts';
import { runContractReminders } from './contract-reminders.ts';
import { runPhotoRetention } from './photo-retention.ts';
import { CONSUMERS, type Consumer } from './consumers.ts';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

/**
 * Proses latar.
 *
 * Terpisah dari `apps/web` dengan sengaja, meski keduanya satu basis kode. Ini
 * peredam untuk risiko N2 (PLAN/12 §10.3): pekerjaan berat — impor Excel, proses
 * payroll, pembuatan PDF — tidak boleh menahan request pengguna. Pemisahan
 * proses adalah cara termurah menjamin itu tanpa memecah sistem menjadi service.
 */

const POLL_INTERVAL_MS = 2000;

async function main(): Promise<void> {
  const boss = new PgBoss({
    connectionString: process.env['DATABASE_URL']!,
    schema: 'pgboss',
  });

  boss.on('error', (error: unknown) => console.error({ scope: 'pg-boss', error }));
  await boss.start();

  // pg-boss 12 menuntut antrean dibuat eksplisit sebelum dipakai. Membuatnya di
  // sini — dari katalog topik yang sama yang dipakai penerbit — berarti sebuah
  // topik baru tidak dapat lolos ke produksi tanpa antreannya ikut terbawa.
  // Idempoten, jadi aman dijalankan pada setiap startup.
  for (const topic of Object.values(EventTopic)) {
    await boss.createQueue(topic);
  }

  /**
   * Pendaftaran konsumen.
   *
   * Setiap konsumen WAJIB idempoten: outbox menjamin at-least-once, bukan
   * exactly-once, sehingga pesan yang sama dapat datang dua kali dan itu bukan
   * bug. Untuk email, idempotensinya ada pada `dedupeKey` di notification_logs —
   * bukan pada harapan bahwa pesan tidak akan terkirim ulang.
   *
   * Kegagalan penanganan TIDAK melempar. Melempar akan membuat pg-boss mencoba
   * ulang, dan percobaan ulang atas alamat email yang memang salah hanya
   * menghasilkan kegagalan yang sama berkali-kali. Kegagalannya tercatat pada
   * barisnya sendiri, tempat ia dapat dilihat dan ditindaklanjuti.
   */
  for (const [topic, consumer] of Object.entries(CONSUMERS) as Array<[EventTopic, Consumer]>) {
    if (consumer.kind === 'drain') {
      // Dikuras tanpa efek. Alasannya ada di katalog konsumen, bukan di sini.
      await boss.work(topic, async () => {});
      continue;
    }

    await boss.work(topic, async (jobs) => {
      for (const job of jobs) {
        // Pompa membungkus setiap event: `{ tenantId, correlationId, payload }`.
        // Payload bisnisnya ada satu tingkat di dalam, bukan di akar `job.data`.
        const envelope = job.data as OutboxEnvelope;
        if (!envelope?.tenantId || !envelope.payload) continue;

        try {
          await consumer.run(envelope);
        } catch (error) {
          console.error({ scope: 'consumer', topic, jobId: job.id, error });
        }
      }
    });
  }

  let running = true;
  const stop = async (signal: string): Promise<void> => {
    if (!running) return;
    running = false;
    console.log(`worker: ${signal} diterima, berhenti dengan rapi...`);
    await boss.stop({ graceful: true });
    await disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  /**
   * Pengingat kontrak berjalan sekali sehari.
   *
   * Dipicu interval, bukan cron, karena pemindaiannya idempoten: constraint
   * unique pada (contractId, threshold) membuat pemanggilan kedua di hari yang
   * sama tidak menerbitkan apa pun. Itu menghapus seluruh kelas masalah
   * penjadwalan — worker yang restart tiga kali sehari tetap benar, dan tidak
   * ada jendela yang terlewat bila satu putaran gagal.
   *
   * Dijalankan sekali saat startup supaya deploy pertama tidak menunggu
   * 24 jam untuk pengingat pertamanya.
   */
  const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const runReminders = async (): Promise<void> => {
    try {
      const result = await runContractReminders();
      if (result.reminded > 0 || result.failed > 0) {
        console.log({ scope: 'contract-reminders', ...result });
      }
    } catch (error) {
      console.error({ scope: 'contract-reminders', error });
    }
  };

  /**
   * Retensi foto presensi berjalan bersama pengingat kontrak.
   *
   * Idempoten dengan sendirinya: yang dicari adalah foto yang sudah melewati
   * `photoExpiresAt`, dan begitu terhapus ia tidak lagi masuk pencarian.
   * Worker yang restart berkali-kali sehari tetap benar.
   */
  const runRetention = async (): Promise<void> => {
    try {
      const result = await runPhotoRetention();
      if (result.deleted > 0 || result.failed > 0 || result.alreadyGone > 0) {
        console.log({ scope: 'photo-retention', ...result });
      }
    } catch (error) {
      console.error({ scope: 'photo-retention', error });
    }
  };

  void runReminders();
  void runRetention();
  const reminderTimer = setInterval(() => {
    void runReminders();
    void runRetention();
  }, REMINDER_INTERVAL_MS);
  reminderTimer.unref?.();

  console.log('worker: berjalan. Memompa outbox setiap 2 detik.');

  while (running) {
    try {
      const stats = await pumpOnce(boss);
      if (stats.published > 0 || stats.failed > 0) {
        console.log({ scope: 'outbox', ...stats });
      }
      const stuck = await countStuck();
      if (stuck > 0) console.warn({ scope: 'outbox', stuck });
    } catch (error) {
      console.error({ scope: 'outbox-pump', error });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
