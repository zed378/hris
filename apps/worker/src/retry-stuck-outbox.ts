import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

import { disconnectAll, withOutboxPump } from '@hrms/db';

/**
 * Memulihkan pesan outbox yang sudah kehabisan percobaan.
 *
 * Ada karena batas sepuluh percobaan itu benar tetapi tidak lengkap. Batas itu
 * mencegah pesan yang memang rusak diulang selamanya — tetapi tidak semua
 * kegagalan berulang berarti pesannya rusak. `attendance.punch.flagged` mati
 * sepuluh kali bukan karena isinya salah, melainkan karena antreannya belum
 * pernah dibuat. Pesannya sempurna; tujuannya yang tidak ada.
 *
 * Tanpa alat ini, memperbaiki penyebabnya tidak memulihkan apa pun: pesan yang
 * sudah mati tetap mati, dan satu-satunya jejaknya adalah penghitung peringatan
 * yang naik tanpa memberi tahu apa yang harus dilakukan.
 *
 * SENGAJA manual dan sengaja per-topik. Pemulihan otomatis akan mengubah batas
 * percobaan menjadi tidak berarti — dan yang memutuskan sebuah kegagalan layak
 * diulang adalah orang yang sudah tahu penyebabnya sudah hilang, bukan penjadwal.
 *
 *   pnpm --filter @hrms/worker outbox:retry                       # lihat saja
 *   pnpm --filter @hrms/worker outbox:retry attendance.punch.flagged
 *   pnpm --filter @hrms/worker outbox:retry --all
 */

const arg = process.argv[2];

interface StuckRow {
  topic: string;
  n: bigint;
  last_error: string | null;
}

const stuck = await withOutboxPump(
  (tx) => tx.$queryRaw<StuckRow[]>`
    SELECT topic, count(*) AS n, min(last_error) AS last_error
    FROM messaging.outbox_messages
    WHERE published_at IS NULL AND attempts >= 10
    GROUP BY topic
    ORDER BY 2 DESC
  `,
);

if (stuck.length === 0) {
  console.log('Tidak ada pesan yang kehabisan percobaan.');
} else if (!arg) {
  console.log('Pesan yang kehabisan percobaan:\n');
  for (const row of stuck) {
    console.log(`  ${row.topic}  ×${row.n}`);
    console.log(`      ${(row.last_error ?? '(tanpa galat tercatat)').split('\n')[0]}\n`);
  }
  console.log('Perbaiki penyebabnya lebih dulu, lalu ulangi per topik:');
  console.log(`  pnpm --filter @hrms/worker outbox:retry ${stuck[0]!.topic}`);
} else {
  // Percobaan dikembalikan ke nol, bukan dikurangi. Pesan ini akan dicoba dari
  // awal karena penyebab kegagalan sebelumnya dinyatakan sudah hilang — dan
  // kalau ternyata belum, batas yang sama akan menghentikannya lagi.
  const restored = await withOutboxPump((tx) =>
    arg === '--all'
      ? tx.$executeRaw`
          UPDATE messaging.outbox_messages SET attempts = 0, last_error = NULL
          WHERE published_at IS NULL AND attempts >= 10
        `
      : tx.$executeRaw`
          UPDATE messaging.outbox_messages SET attempts = 0, last_error = NULL
          WHERE published_at IS NULL AND attempts >= 10 AND topic = ${arg}
        `,
  );

  console.log(
    restored === 0
      ? `Tidak ada pesan tertahan pada topik "${arg}".`
      : `${restored} pesan dikembalikan ke antrean. Worker akan memompanya pada putaran berikutnya.`,
  );
}

await disconnectAll();
