import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

/**
 * Gerbang CI cakupan RLS (PLAN/12 F1 DoD).
 *
 * Uji isolasi di berkas sebelahnya membuktikan RLS bekerja pada tabel yang
 * diperiksa. Berkas ini membuktikan sesuatu yang berbeda dan lebih sulit: bahwa
 * **tidak ada tabel yang terlewat**.
 *
 * Perbedaannya penting. Tabel yang lupa diberi kebijakan tidak menyebabkan satu
 * pun uji gagal — ia hanya diam-diam terbuka bagi seluruh tenant sampai ada yang
 * menyadarinya. Karena itu pemeriksaan di sini bersifat menyeluruh: ia membaca
 * katalog PostgreSQL, bukan daftar yang ditulis tangan dan bisa basi.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

afterAll(() => owner.$disconnect());

/** Schema milik tenant plane. `platform` sengaja tidak termasuk. */
const TENANT_SCHEMAS = ['tenant', 'auth', 'iam', 'audit', 'messaging'];

describe('cakupan RLS', () => {
  it('setiap tabel ber-tenant_id punya RLS aktif, FORCE, dan kebijakan isolasi', async () => {
    const rows = await owner.$queryRaw<
      Array<{ schema: string; table: string; rls: boolean; forced: boolean; policies: number }>
    >`
      SELECT c.relnamespace::regnamespace::text AS schema,
             c.relname                          AS table,
             c.relrowsecurity                   AS rls,
             c.relforcerowsecurity              AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      WHERE c.relkind = 'r'
        AND c.relnamespace::regnamespace::text = ANY(${TENANT_SCHEMAS})
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
        )
    `;

    expect(rows.length).toBeGreaterThan(0);

    const unprotected = rows.filter((r) => !r.rls || !r.forced || r.policies === 0);
    expect(
      unprotected.map((r) => `${r.schema}.${r.table} (rls=${r.rls} force=${r.forced} policies=${r.policies})`),
    ).toEqual([]);
  });

  it('tabel tenants terlindungi meski kolom pembedanya bernama id', async () => {
    const [row] = await owner.$queryRaw<Array<{ rls: boolean; forced: boolean; policies: number }>>`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      WHERE c.oid = 'tenant.tenants'::regclass
    `;
    expect(row).toMatchObject({ rls: true, forced: true });
    expect(row!.policies).toBeGreaterThan(0);
  });

  it('tidak ada role aplikasi dengan BYPASSRLS', async () => {
    // Risiko R21: tekanan untuk "mempermudah dukungan" akan muncul berulang kali
    // sepanjang umur sistem, dan setiap kali harus ditolak. Uji ini yang menolaknya.
    const rows = await owner.$queryRaw<Array<{ rolname: string }>>`
      SELECT rolname FROM pg_roles
      WHERE rolbypassrls AND rolname LIKE 'hrms_%' AND rolname <> 'hrms_owner'
    `;
    expect(rows.map((r) => r.rolname)).toEqual([]);
  });

  it('role aplikasi tidak dapat menjangkau schema control plane', async () => {
    // P11: superuser adalah entitas di bidang berbeda, bukan pengguna dengan izin
    // lebih banyak. Pemisahannya ditegakkan hak akses, bukan kesepakatan.
    const [row] = await owner.$queryRaw<Array<{ granted: boolean }>>`
      SELECT has_schema_privilege('hrms_app', 'platform', 'USAGE') AS granted
    `;
    expect(row?.granted).toBe(false);
  });

  it('jumlah fungsi SECURITY DEFINER tetap sesuai yang terdaftar', async () => {
    // Setiap SECURITY DEFINER adalah pengecualian terhadap RLS. Tiga yang ada
    // sekarang punya alasan tertulis di migrasinya masing-masing. Uji ini gagal
    // saat yang keempat muncul — memaksa penambahnya menjelaskan alasannya di PR,
    // bukan menyelipkannya.
    const rows = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT p.proname AS name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND n.nspname IN ('public', 'tenant', 'auth', 'iam', 'audit', 'messaging', 'platform')
      ORDER BY p.proname
    `;
    // Setiap nama di sini punya alasan tertulis di migrasinya. Tiga yang
    // pertama memecahkan masalah yang sama: sebuah token atau kode masuk
    // tanpa membawa tenantnya, sehingga konteks belum dapat dipasang dan RLS
    // mengembalikan nol baris. Ketiganya menerima satu nilai dan mengembalikan
    // seminimal mungkin — id, bukan isi.
    //
    //   resolve_action_token_owner  — alur reset kata sandi & undangan
    //   resolve_refresh_token_owner — alur refresh
    //   resolve_tenant_by_code      — alur login
    //   tenant_user_counts          — dashboard global butuh angka, bukan isi tabel
    //   active_tenant_ids           — job terjadwal, mengembalikan UUID saja
    //   all_tenant_ids              — pemeliharaan data at rest; lihat di bawah
    //
    // `all_tenant_ids` sengaja TIDAK memfilter status, dan itu perbedaan yang
    // penting. Rotasi kunci PII berakhir dengan mencabut kunci lama: baris milik
    // tenant CHURNED yang terlewat menjadi tidak terbaca selamanya, dan itu
    // penghancuran data, bukan pekerjaan yang dilewati. Job terjadwal biasa
    // tetap harus memakai `active_tenant_ids`.
    expect(rows.map((r) => r.name)).toEqual([
      'active_tenant_ids',
      'all_tenant_ids',
      'resolve_action_token_owner',
      'resolve_refresh_token_owner',
      'resolve_tenant_by_code',
      'tenant_user_counts',
    ]);
  });

  it('katalog global bersifat baca-saja bagi aplikasi', async () => {
    const rows = await owner.$queryRaw<Array<{ tbl: string; ins: boolean; upd: boolean }>>`
      SELECT t AS tbl,
             has_table_privilege('hrms_app', t, 'INSERT') AS ins,
             has_table_privilege('hrms_app', t, 'UPDATE') AS upd
      FROM unnest(ARRAY['tenant.modules','tenant.plans','tenant.plan_modules',
                        'iam.permissions','iam.menus']) AS t
    `;
    const writable = rows.filter((r) => r.ins || r.upd).map((r) => r.tbl);
    expect(writable).toEqual([]);
  });

  it('control plane tidak dapat membaca data pribadi', async () => {
    // Inti P11 sebagai hak akses, bukan sebagai niat. Bila kelak seseorang
    // menulis pembacaan `auth.users` di kode control plane, PostgreSQL yang
    // menolaknya — bukan reviewer yang kebetulan sempat memperhatikan.
    const [row] = await owner.$queryRaw<
      Array<{ users: boolean; grants: boolean; audit: boolean }>
    >`
      SELECT has_table_privilege('hrms_platform', 'auth.users', 'SELECT')                 AS users,
             has_table_privilege('hrms_platform', 'iam.user_permission_grants', 'SELECT') AS grants,
             has_table_privilege('hrms_platform', 'audit.audit_logs', 'SELECT')           AS audit
    `;
    expect(row).toMatchObject({ users: false, grants: false, audit: false });
  });

  it('role tenant tidak dapat menyentuh jejak control plane', async () => {
    const [row] = await owner.$queryRaw<Array<{ granted: boolean }>>`
      SELECT has_schema_privilege('hrms_app', 'platform', 'USAGE') AS granted
    `;
    expect(row?.granted).toBe(false);
  });

  it('audit_logs tidak dapat diubah aplikasi', async () => {
    const [row] = await owner.$queryRaw<Array<{ upd: boolean; del: boolean }>>`
      SELECT has_table_privilege('hrms_app', 'audit.audit_logs', 'UPDATE') AS upd,
             has_table_privilege('hrms_app', 'audit.audit_logs', 'DELETE') AS del
    `;
    expect(row).toMatchObject({ upd: false, del: false });
  });
});

/**
 * Peran bidang auth (PLAN/14 tahap 5).
 *
 * Batas basis data dibuat SEBELUM batas jaringan, dan urutannya disengaja:
 * matriks GRANT jauh lebih murah diperbaiki selagi semuanya masih satu proses,
 * karena kesalahannya muncul sebagai uji yang gagal, bukan sebagai service yang
 * tidak bisa hidup.
 *
 * Yang dijaga di sini bukan kerapian. `hrms_auth` adalah satu-satunya peran yang
 * memegang hash kata sandi; bila ia juga dapat membaca `employee` dan `payroll`,
 * satu celah di layanan auth berubah menjadi jalan menuju gaji dan NIK seluruh
 * karyawan. Yang menahannya adalah TIADANYA grant, bukan kehati-hatian kode.
 *
 * Ditegaskan positif — bukan sekadar "tidak ada yang memberikannya" — karena
 * `GRANT ... ON ALL TABLES IN SCHEMA` di migrasi mana pun kelak dapat
 * memberikannya tanpa sengaja, dan tidak ada yang akan menyadarinya.
 */
describe('peran hrms_auth', () => {
  it('ada, dan tidak pernah menembus RLS', async () => {
    const [row] = await owner.$queryRaw<Array<{ exists: boolean; bypass: boolean }>>`
      SELECT true AS exists, rolbypassrls AS bypass FROM pg_roles WHERE rolname = 'hrms_auth'
    `;
    expect(row?.exists).toBe(true);
    expect(row?.bypass).toBe(false);
  });

  it('menjangkau schema yang memang miliknya', async () => {
    const [row] = await owner.$queryRaw<
      Array<{ auth: boolean; iam: boolean; tenant: boolean; audit: boolean; messaging: boolean }>
    >`
      SELECT has_schema_privilege('hrms_auth', 'auth', 'USAGE')      AS auth,
             has_schema_privilege('hrms_auth', 'iam', 'USAGE')       AS iam,
             has_schema_privilege('hrms_auth', 'tenant', 'USAGE')    AS tenant,
             has_schema_privilege('hrms_auth', 'audit', 'USAGE')     AS audit,
             has_schema_privilege('hrms_auth', 'messaging', 'USAGE') AS messaging
    `;
    expect(row).toMatchObject({
      auth: true,
      iam: true,
      tenant: true,
      audit: true,
      messaging: true,
    });
  });

  /**
   * Inti dari seluruh tahap ini.
   *
   * Data bisnis tidak boleh terjangkau sama sekali oleh bidang auth — bukan
   * dibatasi RLS, melainkan tidak ada izinnya untuk dicoba.
   */
  it('tidak dapat menjangkau data bisnis sama sekali', async () => {
    const [row] = await owner.$queryRaw<
      Array<{ employee: boolean; attendance: boolean; leave: boolean; payroll: boolean }>
    >`
      SELECT has_schema_privilege('hrms_auth', 'employee', 'USAGE')   AS employee,
             has_schema_privilege('hrms_auth', 'attendance', 'USAGE') AS attendance,
             has_schema_privilege('hrms_auth', 'leave', 'USAGE')      AS leave,
             has_schema_privilege('hrms_auth', 'payroll', 'USAGE')    AS payroll
    `;
    expect(row).toMatchObject({
      employee: false,
      attendance: false,
      leave: false,
      payroll: false,
    });
  });

  it('tidak dapat membaca satu pun tabel bisnis, meski schema-nya kelak terbuka', async () => {
    const [row] = await owner.$queryRaw<
      Array<{ employees: boolean; punches: boolean; payslips: boolean }>
    >`
      SELECT has_table_privilege('hrms_auth', 'employee.employees', 'SELECT')     AS employees,
             has_table_privilege('hrms_auth', 'attendance.punch_logs', 'SELECT')  AS punches,
             has_table_privilege('hrms_auth', 'payroll.payslips', 'SELECT')       AS payslips
    `;
    expect(row).toMatchObject({ employees: false, punches: false, payslips: false });
  });

  it('bukan control plane (P11)', async () => {
    const [row] = await owner.$queryRaw<Array<{ granted: boolean }>>`
      SELECT has_schema_privilege('hrms_auth', 'platform', 'USAGE') AS granted
    `;
    expect(row?.granted).toBe(false);
  });

  it('hanya boleh menambah jejak audit, tidak mengubahnya (P5)', async () => {
    const [row] = await owner.$queryRaw<Array<{ ins: boolean; upd: boolean; del: boolean }>>`
      SELECT has_table_privilege('hrms_auth', 'audit.audit_logs', 'INSERT') AS ins,
             has_table_privilege('hrms_auth', 'audit.audit_logs', 'UPDATE') AS upd,
             has_table_privilege('hrms_auth', 'audit.audit_logs', 'DELETE') AS del
    `;
    expect(row).toMatchObject({ ins: true, upd: false, del: false });
  });

  it('tidak dapat mengubah katalog produk', async () => {
    const [row] = await owner.$queryRaw<Array<{ modules: boolean; permissions: boolean }>>`
      SELECT has_table_privilege('hrms_auth', 'tenant.modules', 'UPDATE')   AS modules,
             has_table_privilege('hrms_auth', 'iam.permissions', 'UPDATE')  AS permissions
    `;
    expect(row).toMatchObject({ modules: false, permissions: false });
  });

  /**
   * Batas yang BELUM selesai, ditegaskan apa adanya.
   *
   * Keadaan akhirnya: backend tidak dapat membaca `auth.users` sama sekali. Hari
   * ini ia harus bisa — enam modul membacanya (`iam.administration`,
   * `iam.resolve-access`, `notification`, `tenant`, `reporting`, `leave`), dan
   * semuanya pindah bersama ke layanan auth pada tahap 6.
   *
   * Uji ini sengaja menegaskan keadaan SEKARANG. Ia akan GAGAL saat grant itu
   * dicabut — dan kegagalannya adalah pengingat untuk memperbarui catatan ini,
   * bukan tanda ada yang rusak. Batas setengah jadi yang tidak ditulis, enam
   * bulan kemudian, terbaca seperti batas yang utuh.
   */
  it('CATATAN: hrms_app masih dapat membaca auth.users sampai tahap 6', async () => {
    const [row] = await owner.$queryRaw<Array<{ granted: boolean }>>`
      SELECT has_table_privilege('hrms_app', 'auth.users', 'SELECT') AS granted
    `;
    expect(row?.granted).toBe(true);
  });
});
