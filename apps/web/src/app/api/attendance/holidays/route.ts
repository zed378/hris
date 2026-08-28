import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { Prisma, writeAudit } from '@hrms/db';
import { revertJointLeave } from '@hrms/core/leave';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Hari libur nasional dan cuti bersama (dokumen 10 §6).
 *
 * Tabelnya ada sejak modul presensi dibangun dan dibaca dua modul — presensi
 * memakainya untuk status `HOLIDAY`, cuti untuk mengecualikannya dari
 * pemotongan saldo — tetapi **tidak ada satu pun jalur yang mengisinya** selain
 * seed, dan seed hanya memuat lima tanggal tahun 2026 yang ditulis tangan.
 *
 * Akibatnya berlipat, dan seluruhnya senyap:
 *
 *   - Tahun 2027 tidak punya satu pun hari libur. Idul Fitri, Nyepi, Waisak,
 *     Natal — tidak ada.
 *   - Cuti yang diajukan melintasi Idul Fitri **memotong saldo** untuk hari
 *     kantor tutup.
 *   - Bila HR menghitung ulang presensi sebulan penuh sebelum payroll, setiap
 *     hari libur tercatat ALFA, dan `hariAlfa` itulah yang dipakai formula gaji
 *     untuk memotong upah.
 *
 * Tidak ada satu pun dari ketiganya yang menghasilkan galat. Yang muncul adalah
 * saldo cuti yang berkurang tanpa sebab dan slip gaji yang lebih kecil dari
 * seharusnya — pada orang yang tidak punya cara membuktikannya.
 *
 * Tanggal libur nasional Indonesia ditetapkan SKB 3 Menteri setiap tahun dan
 * sebagian bergantung pada penanggalan Hijriah, sehingga **tidak dapat dihitung
 * di muka** oleh kode mana pun. Ia harus dapat dimasukkan tenant. Itulah yang
 * disediakan endpoint ini.
 */

export const GET = defineRoute('GET /api/attendance/holidays', async (req, ctx) => {
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year') ?? new Date().getUTCFullYear());

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Tahun tidak sah', ctx.correlationId);
  }

  const holidays = await ctx.tx.holiday.findMany({
    where: {
      tenantId: ctx.tenantId,
      date: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lte: new Date(Date.UTC(year, 11, 31)),
      },
    },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, name: true, isJointLeave: true },
  });

  return NextResponse.json({
    year,
    holidays: holidays.map((holiday) => ({
      id: holiday.id,
      date: holiday.date.toISOString().slice(0, 10),
      name: holiday.name,
      isJointLeave: holiday.isJointLeave,
    })),
  });
});

const createSchema = z.object({
  entries: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().trim().min(2).max(120),
        /**
         * Cuti bersama MEMOTONG hak cuti tahunan; libur nasional tidak.
         *
         * Pembedaan ini bukan tata nama. SKB 3 Menteri menetapkan cuti bersama
         * sebagai pengurang jatah cuti tahunan 12 hari, sehingga menandainya
         * salah berarti perusahaan memberikan empat hari libur berbayar
         * tambahan per karyawan per tahun — atau memotong jatah yang seharusnya
         * utuh.
         */
        isJointLeave: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(60),
});

export const POST = defineRoute('POST /api/attendance/holidays', async (req, ctx) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Daftar hari libur tidak sah',
      ctx.correlationId,
    );
  }

  let created = 0;
  let updated = 0;
  let reverted = 0;

  for (const entry of parsed.data.entries) {
    const date = new Date(`${entry.date}T00:00:00.000Z`);

    // Upsert, bukan create. Menempelkan daftar SKB yang diperbarui di tengah
    // tahun adalah hal yang benar-benar dilakukan HR — pemerintah memang
    // merevisi tanggal cuti bersama — dan menolaknya dengan 409 memaksa mereka
    // menghapus satu per satu lebih dulu.
    const existing = await ctx.tx.holiday.findFirst({
      where: { tenantId: ctx.tenantId, date },
      select: { id: true, isJointLeave: true },
    });

    if (existing) {
      await ctx.tx.holiday.update({
        where: { id: existing.id },
        data: { name: entry.name, isJointLeave: entry.isJointLeave },
      });

      // Turun dari cuti bersama menjadi libur biasa: potongan jatahnya
      // dikembalikan. Tanpa ini, koreksi HR hanya berlaku ke satu arah — salah
      // menandai satu tanggal memotong jatah seratus karyawan, dan
      // membatalkannya tidak mengembalikan apa pun. Pemerintah memang merevisi
      // tanggal cuti bersama di tengah tahun.
      if (existing.isJointLeave && !entry.isJointLeave) {
        reverted += (await revertJointLeave(ctx.tx, ctx.tenantId, existing.id, ctx.userId)).days;
      }

      updated += 1;
    } else {
      await ctx.tx.holiday.create({
        data: {
          tenantId: ctx.tenantId,
          date,
          name: entry.name,
          isJointLeave: entry.isJointLeave,
        },
      });
      created += 1;
    }
  }

  // Diaudit karena hari libur menentukan siapa tercatat ALFA dan berapa saldo
  // cuti terpotong. Menghapus satu tanggal libur diam-diam mengubah gaji orang.
  await writeAudit(ctx.tx, ctx.tenantId, {
    action: 'attendance.holiday.upserted',
    entityType: 'holiday',
    actorUserId: ctx.userId,
    correlationId: ctx.correlationId,
    after: { created, updated, revertedDays: reverted, entries: parsed.data.entries.length },
  });

  return NextResponse.json({ created, updated, revertedDays: reverted }, { status: 201 });
});

const deleteSchema = z.object({ id: z.string().uuid() });

export const DELETE = defineRoute('DELETE /api/attendance/holidays', async (req, ctx) => {
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id tidak sah', ctx.correlationId);
  }

  const holiday = await ctx.tx.holiday.findFirst({
    where: { id: parsed.data.id, tenantId: ctx.tenantId },
    select: { id: true, date: true, name: true, isJointLeave: true },
  });
  if (!holiday) {
    return apiError(404, ErrorCode.NOT_FOUND, 'Hari libur tidak ditemukan', ctx.correlationId);
  }

  // Dikembalikan SEBELUM barisnya dihapus. Setelah dihapus, tidak ada lagi yang
  // menghubungkan potongan di buku besar dengan tanggal yang menyebabkannya,
  // dan jatah seratus karyawan tertinggal terpotong tanpa asal-usul.
  const reverted = holiday.isJointLeave
    ? await revertJointLeave(ctx.tx, ctx.tenantId, holiday.id, ctx.userId)
    : { employees: 0, days: 0 };

  try {
    await ctx.tx.holiday.delete({ where: { id: holiday.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return apiError(
        409,
        ErrorCode.CONFLICT,
        'Hari libur ini masih dirujuk data lain dan tidak dapat dihapus.',
        ctx.correlationId,
      );
    }
    throw error;
  }

  await writeAudit(ctx.tx, ctx.tenantId, {
    action: 'attendance.holiday.deleted',
    entityType: 'holiday',
    entityId: holiday.id,
    actorUserId: ctx.userId,
    correlationId: ctx.correlationId,
    before: {
      date: holiday.date.toISOString().slice(0, 10),
      name: holiday.name,
      isJointLeave: holiday.isJointLeave,
      revertedDays: reverted.days,
    },
  });

  return NextResponse.json({ deleted: holiday.id, reverted });
});
