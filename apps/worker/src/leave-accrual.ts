import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { applyJointLeave, runAccrual } from '@hrms/core/leave';

/**
 * Akrual jatah cuti: menaikkan jatah orang-orang yang menabungnya per bulan.
 *
 * Berjalan harian, bukan bulanan, dan itu disengaja. Job bulanan menuntut
 * seseorang mengetahui apakah putaran bulan lalu berhasil; job harian yang
 * idempoten tidak menuntut siapa pun mengetahui apa pun. Selisihnya nol pada
 * 29 dari 30 hari, dan pada hari ke-30 ia menambahkan jatah yang tepat.
 *
 * Sifat idempotennya berasal dari `runAccrual`, yang membandingkan jatah
 * sekarang dengan jatah yang SEHARUSNYA sudah diperoleh pada hari ini —
 * bukan menambahkan sebulan setiap kali dipanggil.
 */

export interface AccrualSummary {
  tenants: number;
  reviewed: number;
  accrued: number;
  days: number;
  /** Hari yang dipotong cuti bersama. */
  jointLeaveDays: number;
  /** Karyawan yang jatahnya tidak cukup untuk cuti bersama. */
  jointLeaveShortfalls: number;
  failed: number;
}

export async function runLeaveAccrual(asOf: Date = new Date()): Promise<AccrualSummary> {
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.active_tenant_ids()
  `;

  const summary: AccrualSummary = {
    tenants: tenants.length,
    reviewed: 0,
    accrued: 0,
    days: 0,
    jointLeaveDays: 0,
    jointLeaveShortfalls: 0,
    failed: 0,
  };

  for (const { tenant_id: tenantId } of tenants) {
    try {
      // Satu transaksi per tenant. Kegagalan pada tenant kelima tidak boleh
      // membatalkan akrual empat tenant sebelumnya.
      const result = await withTenant(tenantId, (tx) => runAccrual(tx, tenantId, asOf), {
        client: workerClient(),
      });

      summary.reviewed += result.reviewed;
      summary.accrued += result.accrued;
      summary.days += result.days;

      /**
       * Cuti bersama dipotong pada irama yang sama, dan transaksi terpisah.
       *
       * Terpisah karena keduanya menyentuh baris saldo yang sama: kegagalan
       * pemotongan cuti bersama tidak boleh membatalkan akrual yang sudah benar
       * pada tenant itu.
       *
       * Harian dan idempoten dengan alasan yang sama seperti akrual —
       * idempotensinya bertumpu pada baris buku besar yang sudah ada, bukan
       * pada penanda yang harus diingat siapa pun. HR yang menempelkan daftar
       * SKB pada bulan Maret tetap mendapat pemotongan yang benar keesokan
       * harinya, tanpa menekan apa pun.
       */
      const joint = await withTenant(
        tenantId,
        (tx) => applyJointLeave(tx, tenantId, asOf.getUTCFullYear()),
        { client: workerClient() },
      );
      summary.jointLeaveDays += joint.days;
      summary.jointLeaveShortfalls += joint.shortfalls.length;
    } catch (error) {
      summary.failed += 1;
      log.error({ scope: 'leave-accrual', tenantId, error });
    }
  }

  return summary;
}
