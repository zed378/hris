import type { EventTopic } from '@hrms/contracts';
import { currentCorrelationId } from '@hrms/observability';
import type { TenantClient } from './tenant-context.ts';

export interface OutboxEvent {
  /**
   * Bertitik, lampau: `tenant.provisioned`, `iam.access.changed`.
   *
   * Sengaja `EventTopic`, bukan `string`. Worker membuat antrean pg-boss dari
   * katalog yang sama ini pada setiap startup, sehingga topik yang tidak ada di
   * katalog berarti pesan yang diterbitkan ke antrean yang tidak pernah dibuat.
   *
   * Itu persis yang terjadi pada `attendance.punch.flagged`: ia diterbitkan
   * sebagai literal, antreannya tidak pernah ada, dan setiap presensi yang
   * ditandai untuk ditinjau mati setelah sepuluh percobaan. Outbox-nya bekerja
   * sempurna — yang tidak ada adalah tujuannya. `string` di sini adalah lubang
   * yang membuat kesalahan itu mungkin; menutupnya adalah pekerjaan pengetik,
   * bukan pekerjaan peninjau kode.
   */
  topic: EventTopic;
  payload: Record<string, unknown>;
  correlationId?: string | undefined;
}

/**
 * Transactional outbox (PLAN/03 §1.3).
 *
 * Event ditulis dalam transaksi bisnis yang sama, lalu dipublikasikan terpisah
 * oleh worker. Itulah yang membuat "data berubah tetapi event hilang" mustahil:
 * keduanya commit bersama atau tidak sama sekali.
 *
 * Bentuk pemanggilannya sengaja identik dengan versi terdistribusi. Saat sebuah
 * modul dipecah menjadi service (PLAN/12 §9), yang berubah hanya tujuan
 * publikasi di sisi pompa — pemanggil di sini tidak disentuh sama sekali.
 */
export async function publishEvent(
  tx: TenantClient,
  tenantId: string,
  event: OutboxEvent,
): Promise<void> {
  await tx.outboxMessage.create({
    data: {
      tenantId,
      topic: event.topic,
      payload: event.payload as never,
      /**
       * Diambil dari konteks permintaan bila pemanggil tidak menyebutnya.
       *
       * Kolom ini sudah ada sejak awal, tetapi dari dua belas pemanggilan
       * `publishEvent` hanya sebagian yang mengisinya — bukan karena lalai,
       * melainkan karena fungsi domain yang memanggilnya memang tidak menerima
       * `ctx`. Akibatnya jejak satu permintaan terputus tepat di batas antrean:
       * log permintaan punya id korelasi, log worker yang memprosesnya tidak.
       *
       * Nilai eksplisit tetap menang, supaya penerbit yang sengaja meneruskan
       * korelasi dari tempat lain tidak ditimpa.
       */
      correlationId: event.correlationId ?? currentCorrelationId() ?? null,
    },
  });
}
