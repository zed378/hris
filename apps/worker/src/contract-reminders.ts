import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { scanContractReminders } from '@hrms/core/employee';

/**
 * Job harian pengingat kontrak.
 *
 * Pemindaian ini lintas tenant menurut sifatnya — ia harus memeriksa semua orang.
 * Tetapi "lintas tenant" tidak dibiarkan berarti "membaca data semua orang
 * sekaligus": yang dibaca lintas tenant hanyalah **daftar id**, lalu setiap
 * tenant diproses di dalam `withTenant()` sendiri dengan RLS berlaku penuh.
 *
 * Konsekuensinya, satu tenant yang datanya rusak tidak dapat memengaruhi
 * pembacaan tenant lain, dan tidak ada satu pun query dalam job ini yang dapat
 * mengembalikan baris milik dua tenant sekaligus.
 */

export interface ReminderJobResult {
  tenants: number;
  scanned: number;
  reminded: number;
  failed: number;
}

export async function runContractReminders(): Promise<ReminderJobResult> {
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.active_tenant_ids()
  `;

  const result: ReminderJobResult = { tenants: tenants.length, scanned: 0, reminded: 0, failed: 0 };

  for (const { tenant_id: tenantId } of tenants) {
    try {
      const scan = await withTenant(
        tenantId,
        (tx) => scanContractReminders(tx, tenantId),
        { client: workerClient() },
      );
      result.scanned += scan.scanned;
      result.reminded += scan.reminded;
    } catch (error) {
      // Kegagalan satu tenant tidak menghentikan sisanya. Job yang berhenti di
      // tenant pertama yang bermasalah berarti seluruh pelanggan lain kehilangan
      // pengingatnya hari itu — dan kehilangan itu tidak akan terlihat sampai
      // ada PKWT yang terlanjur lewat.
      result.failed += 1;
      log.error({ scope: 'contract-reminders', tenantId, error });
    }
  }

  return result;
}
