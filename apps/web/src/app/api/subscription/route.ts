import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { listModules, setModuleEnabled, SubscriptionError } from '@hrms/core/tenant';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Langganan dan modul aktif tenant (PLAN/12 F6).
 *
 * Modulnya `core`, bukan modul yang sedang diatur. Endpoint yang mengatur
 * langganan tidak boleh ikut mati ketika modul yang diaturnya dinonaktifkan —
 * itu akan mengunci tenant di luar sistemnya sendiri, dan satu-satunya jalan
 * keluar menjadi menghubungi tim, yaitu tepat yang hendak dihapus Fase 6.
 */
export const GET = defineRoute('GET /api/subscription', async (_req, ctx) => {
  const [modules, tenant] = await Promise.all([
    listModules(ctx.tx, ctx.tenantId),
    ctx.tx.tenant.findFirst({
      where: { id: ctx.tenantId },
      select: {
        code: true,
        name: true,
        status: true,
        planCode: true,
        trialEndsAt: true,
        plan: { select: { name: true, description: true } },
      },
    }),
  ]);

  const trialEndsAt = tenant?.trialEndsAt ?? null;

  return NextResponse.json({
    tenant: {
      code: tenant?.code ?? '',
      name: tenant?.name ?? '',
      status: tenant?.status ?? 'UNKNOWN',
      planCode: tenant?.planCode ?? '',
      planName: tenant?.plan?.name ?? '',
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      // Sisa hari dihitung server, bukan klien. Jam perangkat pengguna dapat
      // meleset berhari-hari, dan "uji coba berakhir besok" yang salah adalah
      // pesan yang mendorong orang membayar karena panik.
      trialDaysLeft:
        trialEndsAt === null
          ? null
          : Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86_400_000)),
    },
    modules,
  });
});

const schema = z.object({
  moduleCode: z.string().trim().min(1).max(32),
  enabled: z.boolean(),
});

export const POST = defineRoute('POST /api/subscription', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Sebutkan modul dan status yang diinginkan.',
      ctx.correlationId,
    );
  }

  try {
    const result = await setModuleEnabled(
      ctx.tx,
      ctx.tenantId,
      parsed.data.moduleCode,
      parsed.data.enabled,
      ctx.userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SubscriptionError) {
      return apiError(
        error.kind === 'not_found' ? 404 : error.kind === 'not_in_plan' ? 402 : 409,
        error.kind === 'not_found'
          ? ErrorCode.NOT_FOUND
          : error.kind === 'not_in_plan'
            ? ErrorCode.MODULE_NOT_SUBSCRIBED
            : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
