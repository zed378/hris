import type { Prisma, PrismaClient } from '@prisma/client';
import { appClient, workerClient } from './client.ts';

/**
 * Klien yang sudah terikat pada satu tenant. Bentuknya sama dengan PrismaClient
 * tetapi tanpa `$transaction` — bersarang di dalam transaksi bukan hal yang
 * kita inginkan, dan menghapusnya dari tipe membuat itu galat kompilasi.
 */
export type TenantClient = Prisma.TransactionClient;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`tenantId bukan UUID yang sah: ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Menjalankan `fn` dalam satu transaksi dengan konteks tenant terpasang.
 *
 * Tiga hal yang membuat ini aman, dan ketiganya berpasangan:
 *
 * 1. `set_config(..., true)` bersifat **transaction-scoped**. Saat transaksi
 *    berakhir, konteks hilang bersamanya. Inilah yang membuat connection pool
 *    tidak dapat membocorkan konteks tenant A ke request tenant B — kegagalan
 *    yang tidak melempar galat, ia hanya menampilkan data orang lain.
 *
 * 2. `set_config` menerima parameter terikat. `SET LOCAL` tidak, dan merangkai
 *    string ke dalamnya adalah injeksi SQL langsung ke penentu isolasi tenant.
 *
 * 3. tenantId divalidasi sebagai UUID sebelum menyentuh basis data. Bila nilai
 *    tak sah lolos, `app_current_tenant()` akan melempar saat cast dan seluruh
 *    query gagal — gagal-tertutup, tetapi galatnya membingungkan. Lebih baik
 *    ditolak di sini.
 *
 * Referensi: PLAN/06 §2.6, PLAN/12 §3.3, spike S3.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
  options?: { client?: PrismaClient; timeoutMs?: number },
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const client = options?.client ?? appClient();

  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
  );
}

/**
 * Untuk membaca katalog global — modul, paket, permission, menu.
 *
 * Tabel-tabel itu tidak punya `tenant_id` dan tidak punya RLS, karena ia definisi
 * produk, bukan data pelanggan. Fungsi ini sengaja dinamai berbeda agar
 * pemakaiannya pada tabel tenant terlihat mencolok saat review.
 */
export function catalog(): PrismaClient {
  return appClient();
}

/**
 * Konteks infrastruktur untuk pompa outbox.
 *
 * Satu-satunya jalur dalam sistem yang membaca lintas tenant, dan ia dibatasi
 * pada satu tabel oleh kebijakan `outbox_publisher`. Bukan pintu belakang:
 * role `hrms_worker` tetap NOBYPASSRLS dan tetap terkurung di tabel lain —
 * ada uji CI yang memverifikasinya.
 */
export async function withOutboxPump<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return workerClient().$transaction(async (tx) => fn(tx));
}
