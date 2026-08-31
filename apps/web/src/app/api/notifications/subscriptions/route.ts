import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import {
  saveSubscription,
  removeSubscription,
  pushConfigured,
  pushPublicKey,
} from '@hrms/core/notification';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Langganan Web Push milik pengguna yang sedang masuk.
 *
 * `userId` selalu diturunkan dari sesi, tidak pernah dari badan permintaan.
 * Menerimanya dari klien berarti siapa pun dapat mendaftarkan perangkatnya
 * sendiri sebagai tujuan notifikasi orang lain — dan notifikasi cuti memuat nama
 * serta tanggal.
 */

export const GET = defineRoute('GET /api/notifications/subscriptions', async (_req, ctx) => {
  const subscriptions = await ctx.tx.pushSubscription.findMany({
    where: { tenantId: ctx.tenantId, userId: ctx.userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true, lastSuccessAt: true },
  });

  return NextResponse.json({
    // Kunci publik dikirim di sini, bukan sebagai variabel lingkungan klien.
    // Ia memang aman dibagikan, tetapi mengirimnya bersama daftar langganan
    // berarti klien tidak dapat mencoba berlangganan pada instalasi yang belum
    // mengonfigurasi push — dan percobaan itu akan membakar satu-satunya
    // kesempatan meminta izin notifikasi.
    configured: pushConfigured(),
    publicKey: pushPublicKey(),
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      // Endpoint dipotong: ia panjang, dan bagian akhirnya adalah pengenal
      // perangkat yang tidak perlu ditampilkan utuh.
      endpoint: `${s.endpoint.slice(0, 40)}…`,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
    })),
  });
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(10).max(200),
    auth: z.string().min(10).max(200),
  }),
  userAgent: z.string().max(300).optional(),
});

export const POST = defineRoute('POST /api/notifications/subscriptions', async (req, ctx) => {
  const parsed = subscribeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data langganan tidak sah', ctx.correlationId);
  }

  const saved = await saveSubscription(ctx.tx, ctx.tenantId, ctx.userId, {
    endpoint: parsed.data.endpoint,
    keys: parsed.data.keys,
    userAgent: parsed.data.userAgent ?? ctx.userAgent,
  });

  return NextResponse.json(saved, { status: 201 });
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

export const DELETE = defineRoute('DELETE /api/notifications/subscriptions', async (req, ctx) => {
  const parsed = unsubscribeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Endpoint tidak sah', ctx.correlationId);
  }

  const removed = await removeSubscription(ctx.tx, ctx.tenantId, parsed.data.endpoint);
  return NextResponse.json({ removed });
});
