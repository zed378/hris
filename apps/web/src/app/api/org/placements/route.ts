import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { placeEmployee, OrgError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  employeeId: z.string().uuid(),
  departmentId: z.string().uuid(),
  positionId: z.string().uuid(),
  type: z.enum(['PKWTT', 'PKWT', 'MAGANG', 'HARIAN', 'BORONGAN']),
  effectiveFrom: z.coerce.date(),
  managerId: z.string().uuid().nullable().optional(),
});

/**
 * Menempatkan atau memutasi karyawan.
 *
 * Riwayat tidak pernah ditimpa (P13): periode berjalan ditutup H-1 dan baris baru
 * dibuka. Pertanyaan "siapa kepala departemen ini bulan Maret lalu" karenanya
 * tetap dapat dijawab tahun depan — dan pertanyaan itu muncul setiap kali ada
 * sengketa.
 */
export const POST = defineRoute('POST /api/org/placements', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data penempatan tidak sah', ctx.correlationId);
  }

  try {
    return NextResponse.json(
      await placeEmployee(ctx.tx, ctx.tenantId, parsed.data, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OrgError) {
      const status = error.kind === 'not_found' ? 404 : 400;
      return apiError(status, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
