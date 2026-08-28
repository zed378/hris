import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Membaca jejak audit tenant (P5).
 *
 * Jejaknya ditulis sejak Fase 1 pada setiap jalur yang mengubah data, tabelnya
 * append-only, dan hak UPDATE/DELETE-nya dicabut bahkan bagi pemilik tabel.
 * Yang tidak ada sampai sekarang: **satu pun cara membacanya.** Izin
 * `iam.audit.read` ada, menu "Jejak Audit" tampil di sidebar, dan tidak ada
 * endpoint maupun halaman di belakangnya.
 *
 * Jejak audit yang tidak dapat dibaca bukan setengah fitur — ia nol fitur.
 * Seluruh gunanya adalah menjawab "siapa mengubah ini, kapan, dan dari nilai
 * berapa", dan pertanyaan itu selalu datang dari orang yang tidak punya akses
 * `psql`.
 *
 * `before` dan `after` sudah diredaksi saat ditulis — kunci sensitif diganti
 * `[redacted]` oleh `writeAudit`, bukan di sini. Redaksi pada saat baca akan
 * meninggalkan nilai aslinya tersimpan, dan tersimpan adalah yang penting.
 */

const querySchema = z.object({
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(64).optional(),
  actorUserId: z.string().uuid().optional(),
  action: z.string().trim().max(128).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const GET = defineRoute('GET /api/audit', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Penyaring tidak sah', ctx.correlationId);
  }

  const q = parsed.data;

  const rows = await ctx.tx.auditLog.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      // Awalan, bukan kecocokan persis: "payroll." menampilkan seluruh tindakan
      // payroll. Penyaring yang menuntut nama aksi persis hanya berguna bagi
      // yang sudah tahu nama aksinya.
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
              ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      // Kursor berbasis id menurun. Offset akan melewatkan baris ketika jejak
      // baru masuk di antara dua halaman — dan pada tabel yang setiap tindakan
      // menambahinya, itu terjadi terus-menerus.
      ...(q.cursor ? { id: { lt: BigInt(q.cursor) } } : {}),
    },
    orderBy: { id: 'desc' },
    take: q.limit,
    select: {
      id: true,
      actorUserId: true,
      action: true,
      entityType: true,
      entityId: true,
      before: true,
      after: true,
      ip: true,
      correlationId: true,
      createdAt: true,
    },
  });

  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const actors = await ctx.tx.user.findMany({
    where: { tenantId: ctx.tenantId, id: { in: actorIds } },
    select: { id: true, fullName: true, email: true },
  });
  const byId = new Map(actors.map((a) => [a.id, a]));

  return NextResponse.json({
    entries: rows.map((row) => ({
      // BigInt tidak dapat di-JSON-kan. Dijadikan string di sini, bukan
      // dibiarkan menjatuhkan seluruh respons dengan "Do not know how to
      // serialize a BigInt" — kegagalan yang sama pernah menjatuhkan ekspor
      // portabilitas.
      id: String(row.id),
      at: row.createdAt.toISOString(),
      // Aktor null berarti tindakan sistem — job terjadwal atau konsumer event.
      // Ditampilkan sebagai "Sistem", bukan dikosongkan: baris tanpa pelaku
      // terbaca seperti data yang hilang.
      actor: row.actorUserId
        ? (byId.get(row.actorUserId) ?? { id: row.actorUserId, fullName: '(pengguna terhapus)', email: '' })
        : { id: null, fullName: 'Sistem', email: '' },
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      ip: row.ip,
      correlationId: row.correlationId,
    })),
    nextCursor: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null,
  });
});
