import type { TenantClient } from './tenant-context.ts';

export interface OutboxEvent {
  /** Bertitik, lampau: `tenant.provisioned`, `iam.access.changed`. */
  topic: string;
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
      correlationId: event.correlationId ?? null,
    },
  });
}
