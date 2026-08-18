import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { recordPunch, PunchError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  type: z.enum(['IN', 'OUT', 'BREAK_START', 'BREAK_END']),
  punchedAt: z.coerce.date(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracyM: z.number().int().min(0).max(100_000).nullable().optional(),
  photoKey: z.string().max(255).nullable().optional(),
  mockLocationReported: z.boolean().optional(),
  /** Dibangkitkan klien SEBELUM mengirim — kunci idempotensi antrean luring. */
  dedupeKey: z.string().min(8).max(128),
  deviceInfo: z.string().max(255).nullable().optional(),
});

/**
 * Mencatat ketukan presensi milik diri sendiri.
 *
 * Karyawan hanya dapat mengetuk untuk dirinya — `employeeId` diturunkan dari
 * sesi, tidak pernah dari badan request. Menerima `employeeId` dari klien akan
 * membuat siapa pun dapat mengabsenkan orang lain.
 *
 * Tidak pernah menolak karena bukti lemah. Presensi di luar geofence, tanpa foto,
 * atau dengan GPS buruk tetap tercatat dan ditandai untuk ditinjau HR (P14).
 */
export const POST = defineRoute('POST /api/attendance/punch', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data presensi tidak lengkap',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  // Pemetaan pengguna → karyawan lewat email. Referensi lunak, sesuai pola
  // replika di PLAN/01 §4.2: modul presensi tidak memegang kunci asing ke
  // employee, sehingga keduanya dapat dipisah kelak tanpa membongkar tabel.
  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  if (!me) {
    return apiError(
      404,
      ErrorCode.NOT_FOUND,
      'Akun Anda belum terhubung ke data karyawan. Hubungi admin HR.',
      ctx.correlationId,
    );
  }

  try {
    const result = await recordPunch(
      ctx.tx,
      ctx.tenantId,
      { ...parsed.data, employeeId: me.id, source: 'WEB', ip: ctx.ip ?? null },
      ctx.userId,
    );
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof PunchError) {
      // Balapan pengiriman ganda dijawab 200, bukan galat. Tepat satu baris
      // tersimpan, dan dari sudut pandang klien ketukannya memang sudah tercatat —
      // yang dibutuhkan antrean luring adalah izin untuk menghapusnya.
      if (error.kind === 'duplicate') {
        return NextResponse.json({ duplicate: true }, { status: 200 });
      }
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
