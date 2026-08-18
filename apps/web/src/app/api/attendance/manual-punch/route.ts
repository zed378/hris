import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { recordPunch, recalculateEmployeeDate, PunchError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(['IN', 'OUT', 'BREAK_START', 'BREAK_END']),
  /** Waktu lokal dari formulir HR, sudah dikonversi klien menjadi ISO. */
  punchedAt: z.coerce.date(),
  reason: z.string().trim().min(4).max(500),
});

/**
 * Ketukan yang dimasukkan HR atas nama karyawan.
 *
 * Ada karena tanpanya antrean tinjauan tidak lengkap: HR dapat menyetujui atau
 * menolak ketukan yang ADA, tetapi karyawan yang lupa mengetuk sama sekali tidak
 * meninggalkan apa pun untuk disetujui. Sebelum ini, satu-satunya jalan
 * memperbaikinya adalah menyentuh basis data langsung.
 *
 * Tiga hal melekat pada setiap baris yang dibuat di sini:
 *
 *   1. Alasannya wajib, dipaksakan oleh tipe — bukan sekadar validasi request.
 *   2. Jejak auditnya ditulis apa pun skornya, memuat siapa dan kapan.
 *   3. Skor kepercayaannya tetap rendah dan tetap terlihat. Bukti untuk ketukan
 *      ini memang lemah, dan menyembunyikan itu akan membuat baris manual tidak
 *      dapat dibedakan dari kehadiran yang benar-benar terekam.
 *
 * Rekap hariannya dihitung ulang seketika. Koreksi yang tidak mengubah angka
 * yang dilihat HR bukan koreksi — ia hanya baris tambahan di tabel yang salah.
 */
export const POST = defineRoute('POST /api/attendance/manual-punch', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Entri manual wajib menyertakan karyawan, waktu, dan alasan minimal 4 karakter',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const { employeeId, type, punchedAt, reason } = parsed.data;

  try {
    const result = await recordPunch(
      ctx.tx,
      ctx.tenantId,
      {
        employeeId,
        type,
        punchedAt,
        source: 'MANUAL',
        manualReason: reason,
        // Kunci idempotensi dibangun dari isinya, bukan dibangkitkan acak.
        // Formulir yang terkirim dua kali karena klik ganda menghasilkan kunci
        // yang sama, dan baris keduanya ditolak — tanpa HR perlu tahu.
        dedupeKey: `manual:${employeeId}:${type}:${punchedAt.toISOString()}`,
        ip: ctx.ip ?? null,
      },
      ctx.userId,
    );

    const recalculated = await recalculateEmployeeDate(
      ctx.tx,
      ctx.tenantId,
      employeeId,
      new Date(`${result.workDate}T00:00:00.000Z`),
    );

    return NextResponse.json(
      { ...result, dayRecalculated: recalculated.saved },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof PunchError) {
      if (error.kind === 'locked') {
        // 409, bukan 400. Permintaannya sah; keadaan sistemlah yang menolaknya,
        // dan HR perlu tahu bedanya supaya tidak mencoba memperbaiki formulirnya.
        return apiError(409, ErrorCode.CONFLICT, error.message, ctx.correlationId);
      }
      if (error.kind === 'duplicate') {
        return NextResponse.json({ duplicate: true }, { status: 200 });
      }
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});
