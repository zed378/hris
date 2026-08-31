import type { Broker } from './broker.ts';
import { withOutboxPump } from '@hrms/db';

/**
 * Pompa outbox: memindahkan event dari tabel `messaging.outbox_messages` ke
 * antrean pg-boss (PLAN/03 §1.3).
 *
 * Mengapa ada dua langkah, bukan langsung mengantre saat aksi bisnis terjadi:
 * antrean berada di luar transaksi bisnis. Bila kita mengantre langsung, ada dua
 * kegagalan yang mungkin — data commit tetapi antrean gagal (event hilang
 * selamanya), atau antrean berhasil tetapi transaksi rollback (konsumer bereaksi
 * terhadap sesuatu yang tidak pernah terjadi). Outbox menghapus keduanya:
 * penulisan event ikut commit bersama datanya, dan pompa ini menjamin
 * pengiriman *at-least-once* sesudahnya.
 *
 * Konsekuensi yang harus diterima: setiap konsumer wajib idempoten, karena
 * "at-least-once" berarti pesan yang sama bisa datang dua kali.
 */

const BATCH_SIZE = 100;

export interface PumpStats {
  published: number;
  failed: number;
}

/**
 * Satu putaran pompa.
 *
 * `FOR UPDATE SKIP LOCKED` adalah bagian yang menanggung beban konkurensi: dua
 * proses pompa yang berjalan bersamaan mengambil baris yang berlainan, bukan
 * berebut baris yang sama lalu saling memblokir. Ini yang memungkinkan worker
 * di-scale tanpa koordinasi tambahan.
 *
 * Berjalan sebagai role `hrms_worker`, satu-satunya principal dengan kebijakan
 * lintas tenant pada tabel ini — dan hanya pada tabel ini.
 */
/**
 * Amplop yang membungkus setiap event saat berpindah dari outbox ke pg-boss.
 *
 * Payload bisnisnya ada satu tingkat di dalam, bukan di akar `job.data` — dan
 * konsumen yang lupa itu tidak gagal, ia hanya membaca `undefined` untuk setiap
 * kolom. Diketik di sini, di tempat amplopnya dibangun, supaya produsen dan
 * konsumen tidak dapat berbeda pendapat soal bentuknya.
 */
export interface OutboxEnvelope<T = Record<string, unknown>> {
  tenantId: string;
  correlationId: string | null;
  payload: T;
}

/**
 * The destination is an interface, not pg-boss (PLAN/14 stage 7).
 *
 * The outbox is the part that must survive a change of broker: it is what makes
 * a job impossible to lose and impossible to fire for a write that rolled back,
 * and no broker provides that on its own. Only where the row goes changes.
 */
export async function pumpOnce(broker: Broker): Promise<PumpStats> {
  const stats: PumpStats = { published: 0, failed: 0 };

  const rows = await withOutboxPump((tx) =>
    tx.$queryRaw<
      Array<{ id: string; tenant_id: string; topic: string; payload: unknown; correlation_id: string | null }>
    >`
      SELECT id, tenant_id, topic, payload, correlation_id
      FROM messaging.outbox_messages
      WHERE published_at IS NULL AND attempts < 10
      ORDER BY created_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `,
  );

  for (const row of rows) {
    try {
      const envelope: OutboxEnvelope = {
        tenantId: row.tenant_id,
        correlationId: row.correlation_id,
        payload: row.payload as Record<string, unknown>,
      };
      await broker.publish(row.topic, envelope);

      await withOutboxPump(
        (tx) => tx.$executeRaw`
          UPDATE messaging.outbox_messages SET published_at = now() WHERE id = ${row.id}::uuid
        `,
      );
      stats.published += 1;
    } catch (error) {
      // Kegagalan dicatat pada barisnya, bukan dilempar. Satu event yang tidak
      // dapat diantre tidak boleh menghentikan pompa untuk seluruh tenant lain.
      // Setelah 10 percobaan barisnya berhenti diambil dan menunggu perhatian
      // manusia — lebih baik satu event tertahan daripada pompa berputar selamanya.
      await withOutboxPump(
        (tx) => tx.$executeRaw`
          UPDATE messaging.outbox_messages
          SET attempts = attempts + 1, last_error = ${String(error).slice(0, 500)}
          WHERE id = ${row.id}::uuid
        `,
      );
      stats.failed += 1;
    }
  }

  return stats;
}

/** Jumlah event yang menyerah setelah batas percobaan. Layak dipantau. */
export async function countStuck(): Promise<number> {
  const rows = await withOutboxPump(
    (tx) => tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM messaging.outbox_messages
      WHERE published_at IS NULL AND attempts >= 10
    `,
  );
  return Number(rows[0]?.n ?? 0);
}
