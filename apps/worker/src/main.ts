import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PgBoss } from 'pg-boss';
import { disconnectAll } from '@hrms/db';
import { EventTopic } from '@hrms/contracts';
import { countStuck, pumpOnce } from './outbox-pump.ts';

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

  // Konsumer contoh. Setiap konsumer WAJIB idempoten: outbox menjamin
  // at-least-once, bukan exactly-once, sehingga pesan yang sama dapat datang
  // dua kali dan itu bukan bug.
  await boss.work(EventTopic.USER_LOGGED_IN, async (jobs) => {
    console.log({ event: EventTopic.USER_LOGGED_IN, data: jobs[0]?.data });
  });

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
