import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { readPolicy, updatePolicy, checkOfficeNetwork } from '@hrms/core/attendance';
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
export const GET = defineRoute('GET /api/attendance/policy', async (_req, ctx) => {
  const [policy, office] = await Promise.all([
    readPolicy(ctx.tx, ctx.tenantId),
    // `null` as the address: nothing is being matched here, only asked whether
    // there is anything to match against.
    checkOfficeNetwork(ctx.tx, ctx.tenantId, null),
  ]);

  /**
   * `officeNetworkConfigured` travels with the policy, not separately.
   *
   * `FALLBACK_ONLY` degrades to `ALLOW_FLAGGED` when no work site has a network
   * registered, because refusing instead would lock out a whole company over a
   * list they may not know exists. That degradation has to be visible on the
   * screen where the policy is chosen — a setting that quietly does nothing is
   * what this whole change exists to remove, and reintroducing it one layer up
   * would be the same bug wearing a different hat.
   */
  return NextResponse.json({ ...policy, officeNetworkConfigured: office.configured });
});

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

  /**
   * The response carries `officeNetworkConfigured` for the same reason the GET
   * does — and it is not optional here.
   *
   * The settings screen replaces its state with whatever this returns. Leaving
   * the flag out would make the screen forget, the moment the policy is saved,
   * that a network exists: switching to `FALLBACK_ONLY` would show the warning
   * that says the setting does nothing, at the exact instant it started doing
   * something. Same silent lie as before, one layer up.
   */
  // Sequential, not `Promise.all`: a write and a read issued concurrently on the
  // same interactive transaction share one connection, and the read can observe
  // the write half-applied.
  const policy = await updatePolicy(ctx.tx, ctx.tenantId, parsed.data, ctx.userId);
  const office = await checkOfficeNetwork(ctx.tx, ctx.tenantId, null);

  return NextResponse.json({ ...policy, officeNetworkConfigured: office.configured });
});
