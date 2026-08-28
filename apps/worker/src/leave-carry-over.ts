import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { runCarryOver } from '@hrms/core/leave';

/**
 * Penutupan tahun cuti: bawa sisa yang boleh dibawa, hanguskan sisanya.
 *
 * Dijalankan sekali di awal tahun, dan **idempoten** — menjalankannya lagi tidak
 * menggandakan apa pun. Sifat itu bukan kemewahan: job tahunan adalah job yang
 * paling mudah dijalankan dua kali, karena tidak ada seorang pun yang ingat
 * apakah ia sudah berjalan Januari lalu.
 *
 * Yang dihanguskan SELALU meninggalkan baris buku besar. Saldo yang berkurang
 * tanpa riwayat tidak dapat dijelaskan kepada karyawan yang bertanya ke mana
 * perginya empat hari cutinya — dan pertanyaan itu selalu datang di bulan
 * Januari, saat orang membuka saldonya untuk pertama kali di tahun baru.
 */

export interface CarryOverSummary {
  tenants: number;
  employees: number;
  carriedOver: number;
  expired: number;
  failed: number;
}

export async function runLeaveCarryOver(fromYear: number): Promise<CarryOverSummary> {
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.active_tenant_ids()
  `;

  const summary: CarryOverSummary = {
    tenants: tenants.length,
    employees: 0,
    carriedOver: 0,
    expired: 0,
    failed: 0,
  };

  for (const { tenant_id: tenantId } of tenants) {
    try {
      // Satu transaksi per tenant, bukan satu untuk semuanya. Kegagalan pada
      // tenant kelima tidak boleh membatalkan penutupan empat tenant sebelumnya.
      const result = await withTenant(tenantId, (tx) => runCarryOver(tx, tenantId, fromYear), {
        client: workerClient(),
      });

      summary.employees += result.employees;
      summary.carriedOver += result.carriedOver;
      summary.expired += result.expired;
    } catch (error) {
      summary.failed += 1;
      log.error({ scope: 'leave-carry-over', tenantId, fromYear, error });
    }
  }

  return summary;
}
