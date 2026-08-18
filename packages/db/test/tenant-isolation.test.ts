import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { withTenant, InvalidTenantIdError, appClient, disconnectAll } from '../src/index.ts';

/**
 * Gerbang CI isolasi tenant (PLAN/12 F1 DoD).
 *
 * Berkas ini menguji satu hal, dan hal itu adalah yang paling mahal bila salah:
 * satu kebocoran lintas-tenant mengakhiri produk B2B. Uji-uji di sini sengaja
 * berbicara ke basis data sungguhan, karena yang diuji adalah perilaku
 * PostgreSQL — RLS, `set_config` transaction-scoped, `WITH CHECK` — bukan
 * perilaku kode kita.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const ALPHA = randomUUID();
const BETA = randomUUID();
const suffix = ALPHA.slice(0, 8);

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'test-plan' },
    create: { code: 'test-plan', name: 'Test' },
    update: {},
  });
  for (const [id, code] of [
    [ALPHA, `t-alpha-${suffix}`],
    [BETA, `t-beta-${suffix}`],
  ] as const) {
    await owner.tenant.create({
      data: { id, code, name: `Tenant ${code}`, planCode: 'test-plan' },
    });
    await owner.user.create({
      data: {
        tenantId: id,
        email: `user@${code}.test`,
        passwordHash: 'x',
        fullName: `User ${code}`,
      },
    });
  }
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: { in: [ALPHA, BETA] } } });
  await owner.$disconnect();
  await disconnectAll();
});

describe('isolasi tenant', () => {
  it('hanya melihat baris milik tenant pada konteks', async () => {
    const alphaEmails = await withTenant(ALPHA, (tx) =>
      tx.user.findMany({ select: { email: true } }),
    );
    const betaEmails = await withTenant(BETA, (tx) =>
      tx.user.findMany({ select: { email: true } }),
    );

    expect(alphaEmails.map((u) => u.email)).toEqual([`user@t-alpha-${suffix}.test`]);
    expect(betaEmails.map((u) => u.email)).toEqual([`user@t-beta-${suffix}.test`]);
  });

  it('gagal-tertutup tanpa konteks tenant: nol baris, bukan seluruh tabel', async () => {
    // Ini perilaku yang paling penting dalam seluruh berkas ini. Bila sebuah
    // jalur kode lupa memasang konteks, ia harus melihat nol baris — bukan data
    // seluruh pelanggan. Kegagalan mode ini tidak melempar galat, ia hanya
    // menampilkan data orang lain.
    const rows = await appClient().user.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it('konteks tidak bocor ke query berikutnya di koneksi yang sama', async () => {
    await withTenant(ALPHA, (tx) => tx.user.findMany());
    // Query berikutnya dapat memakai koneksi pool yang sama. `set_config(..., true)`
    // bersifat transaction-scoped, sehingga konteksnya harus sudah hilang.
    const leaked = await appClient().user.findMany({ select: { id: true } });
    expect(leaked).toHaveLength(0);
  });

  it('menolak menulis baris milik tenant lain (WITH CHECK)', async () => {
    await expect(
      withTenant(ALPHA, (tx) =>
        tx.user.create({
          data: {
            tenantId: BETA,
            email: 'penyusup@alpha.test',
            passwordHash: 'x',
            fullName: 'Penyusup',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tidak dapat mengubah baris tenant lain meski id-nya diketahui', async () => {
    const target = await owner.user.findFirstOrThrow({
      where: { tenantId: BETA },
      select: { id: true },
    });

    const affected = await withTenant(ALPHA, (tx) =>
      tx.user.updateMany({ where: { id: target.id }, data: { fullName: 'Diretas' } }),
    );

    expect(affected.count).toBe(0);
    const after = await owner.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.fullName).not.toBe('Diretas');
  });

  it('menolak tenantId yang bukan UUID sebelum menyentuh basis data', async () => {
    await expect(withTenant("' OR '1'='1", async () => null)).rejects.toBeInstanceOf(
      InvalidTenantIdError,
    );
  });

  it('konteks tenant dipasang lewat parameter terikat, bukan rangkaian string', async () => {
    // Bila `set_config` dirangkai sebagai string, masukan ini akan menutup
    // literalnya dan menjalankan SQL tambahan. UUID sah agar validator lolos,
    // lalu ditambahi muatan.
    const injected = `${BETA}'; SET app.tenant_id = '${ALPHA}`;
    await expect(withTenant(injected, async () => null)).rejects.toBeInstanceOf(
      InvalidTenantIdError,
    );
  });
});

describe('jejak audit', () => {
  it('menolak UPDATE dan DELETE', async () => {
    await withTenant(ALPHA, (tx) =>
      tx.auditLog.create({
        data: { tenantId: ALPHA, action: 'test.probe', entityType: 'test' },
      }),
    );

    await expect(
      withTenant(ALPHA, (tx) =>
        tx.auditLog.updateMany({ where: { tenantId: ALPHA }, data: { action: 'diubah' } }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(ALPHA, (tx) => tx.auditLog.deleteMany({ where: { tenantId: ALPHA } })),
    ).rejects.toThrow();
  });
});
