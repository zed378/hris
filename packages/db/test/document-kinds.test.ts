import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { DOCUMENT_KINDS } from '@hrms/contracts';
import { afterAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

/**
 * Daftar jenis dokumen harus sama di TypeScript dan di basis data.
 *
 * Daftar ini pernah ditulis tangan di tiga tempat: CHECK constraint di
 * PostgreSQL, sebuah konstanta di core, dan sebuah array di halaman unggah.
 * Ketiganya sudah sempat berbeda — 'KITAS' tidak ada di satu pun dari ketiganya,
 * padahal itulah dokumen yang paling perlu diingat kedaluwarsanya.
 *
 * Perbedaan seperti itu tidak menghasilkan galat saat kompilasi maupun saat
 * deploy. Ia muncul sebagai HTTP 500 pada unggahan pertama seseorang, dengan
 * pesan basis data yang tidak menjelaskan apa pun kepada yang mengalaminya.
 *
 * Uji ini membaca **katalog PostgreSQL**, bukan daftar yang ditulis ulang di
 * berkas uji. Menyalin daftarnya ke sini berarti menguji salinan, dan salinan
 * itu akan ikut basi bersama yang lain.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('jenis dokumen karyawan', () => {
  it('sama persis antara TypeScript dan CHECK constraint basis data', async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'employee_documents_kind_known'
    `;
    expect(rows[0], 'constraint employee_documents_kind_known tidak ditemukan').toBeDefined();

    // Nilai di dalam definisi constraint muncul sebagai 'KTP'::text.
    const fromDb = [...rows[0]!.def.matchAll(/'([A-Z]+)'::text/g)].map((m) => m[1]!);

    expect([...fromDb].sort()).toEqual([...DOCUMENT_KINDS].sort());
  });

  it('memuat perizinan yang berumur', async () => {
    // Bukan sekadar mengulang daftar di atas. Ketiganya adalah alasan kolom
    // `expires_at` dan seluruh pengingat kedaluwarsa dibangun; menghapusnya
    // membuat fitur itu tidak dapat dipicu oleh apa pun, tanpa satu pun galat.
    for (const kind of ['KITAS', 'IMTA', 'SIM']) {
      expect(DOCUMENT_KINDS as readonly string[]).toContain(kind);
    }
  });
});
