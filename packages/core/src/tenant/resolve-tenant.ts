import { appClient } from '@hrms/db';

export interface ResolvedTenant {
  id: string;
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CHURNED';
}

/**
 * Menerjemahkan kode tenant menjadi id, sebelum konteks tenant terpasang.
 *
 * Memakai fungsi SECURITY DEFINER `resolve_tenant_by_code` — lihat migrasi
 * 20260818034500 untuk alasan lengkapnya. Fungsi itu hanya mengembalikan id dan
 * status; bila kelak ada kebutuhan atas kolom lain, kebutuhan itu hampir pasti
 * dapat dipenuhi setelah konteks terpasang, bukan dengan memperlebar fungsi ini.
 *
 * Mengembalikan null untuk tenant yang tidak ada. Pemanggil di jalur login WAJIB
 * memperlakukannya sama persis dengan kata sandi salah — termasuk waktu
 * responsnya — agar endpoint ini tidak menjadi alat pencacah nama tenant.
 */
export async function resolveTenantByCode(code: string): Promise<ResolvedTenant | null> {
  const rows = await appClient().$queryRaw<
    Array<{ tenant_id: string; tenant_status: ResolvedTenant['status'] }>
  >`SELECT * FROM public.resolve_tenant_by_code(${code})`;

  const row = rows[0];
  return row ? { id: row.tenant_id, status: row.tenant_status } : null;
}
