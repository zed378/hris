import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { readPolicy, updatePolicy } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kebijakan presensi tenant (dokumen 10 §2.4).
 *
 * Dapat DIBACA siapa pun yang boleh mengetuk presensi — layar presensi perlu
 * tahu apakah foto wajib sebelum meminta izin kamera, dan meminta izin yang
 * tidak dibutuhkan akan membakar satu-satunya kesempatan bertanya.
 *
 * Hanya dapat DIUBAH pemegang izin mengelola shift: keempat angkanya menentukan
 * berapa banyak presensi yang masuk antrean tinjauan dan berapa lama foto wajah
 * disimpan.
 */
export const GET = defineRoute('GET /api/attendance/policy', async (_req, ctx) =>
  NextResponse.json(await readPolicy(ctx.tx, ctx.tenantId)),
);

const schema = z.object({
  requireLocation: z.boolean().optional(),
  requirePhoto: z.boolean().optional(),
  onPermissionDenied: z.enum(['BLOCK', 'ALLOW_FLAGGED', 'FALLBACK_ONLY']).optional(),
  // Batasnya sama dengan constraint basis datanya. Divalidasi di dua tempat
  // dengan sengaja: yang di sini memberi pesan yang berguna, yang di basis data
  // memastikan tidak ada jalur lain yang dapat melewatinya.
  autoApproveThreshold: z.number().int().min(0).max(100).optional(),
  photoRetentionDays: z.number().int().min(1).max(730).optional(),
});

export const PUT = defineRoute('PUT /api/attendance/policy', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Kebijakan tidak sah. Ambang 0–100, retensi foto 1–730 hari.',
      ctx.correlationId,
    );
  }

  return NextResponse.json(
    await updatePolicy(ctx.tx, ctx.tenantId, parsed.data, ctx.userId),
  );
});
