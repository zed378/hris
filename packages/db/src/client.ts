import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Klien basis data.
 *
 * Ada dua principal, dan perbedaannya bukan kerapian:
 *
 *   app    — runtime web. NOBYPASSRLS, bukan pemilik tabel. Setiap query yang
 *            menyentuh data tenant WAJIB lewat `withTenant()`.
 *   worker — proses latar. Sama seperti app, ditambah satu pengecualian sempit:
 *            kebijakan `outbox_publisher` mengizinkannya membaca outbox lintas
 *            tenant, karena pompa event adalah infrastruktur. Pada seluruh tabel
 *            lain ia sama terkurungnya dengan `app`.
 *
 * Tidak ada klien untuk role owner. Owner hanya dipakai Prisma CLI saat migrasi.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variabel lingkungan ${name} belum dipasang. Salin .env.example menjadi .env.`,
    );
  }
  return value;
}

function createClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

// Instance di-cache pada globalThis agar hot-reload Next.js tidak membuka
// connection pool baru pada setiap perubahan berkas.
const globalForPrisma = globalThis as unknown as {
  __hrmsAppClient?: PrismaClient;
  __hrmsWorkerClient?: PrismaClient;
  __hrmsPlatformClient?: PrismaClient;
  __hrmsAuthClient?: PrismaClient;
};

export function appClient(): PrismaClient {
  globalForPrisma.__hrmsAppClient ??= createClient(required('DATABASE_URL_APP'));
  return globalForPrisma.__hrmsAppClient;
}

/**
 * The auth plane's client (PLAN/14 stage 5).
 *
 * Connects as `hrms_auth`, which reaches `auth`, `iam`, `tenant`, `audit`, and
 * `messaging` — and **nothing** in `employee`, `attendance`, `leave`, or
 * `payroll`. The component holding password hashes must not also be a route to
 * everyone's salary and national ID, and that is enforced by the absence of a
 * grant rather than by the code being careful.
 *
 * Falls back to the app connection when `DATABASE_URL_AUTH` is unset, so a
 * deployment that has not yet provisioned the role keeps working exactly as
 * before. The fallback is deliberately silent about being one: `/api/ready`
 * reports the mode, and `rls-coverage.test.ts` asserts the grants, so the state
 * is observable without every caller having to check.
 *
 * The boundary is not complete yet, and pretending otherwise would be worse than
 * not having it. `hrms_app` can still read `auth.users`, because six modules do
 * — `iam.administration`, `iam.resolve-access`, `notification`, `tenant`,
 * `reporting`, and `leave`. Those move to the auth service in stage 6, together,
 * and the grant is revoked then.
 */
export function authClient(): PrismaClient {
  globalForPrisma.__hrmsAuthClient ??= createClient(
    process.env['DATABASE_URL_AUTH'] ?? required('DATABASE_URL_APP'),
  );
  return globalForPrisma.__hrmsAuthClient;
}

export function workerClient(): PrismaClient {
  globalForPrisma.__hrmsWorkerClient ??= createClient(
    process.env['DATABASE_URL_WORKER'] ?? required('DATABASE_URL_APP'),
  );
  return globalForPrisma.__hrmsWorkerClient;
}

/**
 * Klien control plane.
 *
 * Principal terpisah dengan hak akses yang sengaja sempit: schema `platform`,
 * metadata tenant, dan `tenant_modules`. Tidak ada GRANT ke `auth.users`,
 * `iam.*`, maupun `audit.*` — sehingga kode control plane tidak dapat membaca
 * data pribadi karyawan bahkan bila seseorang menuliskannya (P11).
 *
 * Ini padanan monolit dari `platform-service` yang tidak memiliki kredensial ke
 * basis data domain (PLAN/07 §2). Yang berbeda hanya bahwa di sini pemisahannya
 * ditegakkan hak akses PostgreSQL, bukan batas jaringan.
 */
export function platformClient(): PrismaClient {
  globalForPrisma.__hrmsPlatformClient ??= createClient(required('DATABASE_URL_PLATFORM'));
  return globalForPrisma.__hrmsPlatformClient;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([
    globalForPrisma.__hrmsAppClient?.$disconnect(),
    globalForPrisma.__hrmsWorkerClient?.$disconnect(),
    globalForPrisma.__hrmsPlatformClient?.$disconnect(),
    globalForPrisma.__hrmsAuthClient?.$disconnect(),
  ]);
  delete globalForPrisma.__hrmsAppClient;
  delete globalForPrisma.__hrmsWorkerClient;
  delete globalForPrisma.__hrmsPlatformClient;
  delete globalForPrisma.__hrmsAuthClient;
}

export type { PrismaClient };
