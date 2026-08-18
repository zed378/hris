import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/attendance/work-sites', async (_req, ctx) => {
  const sites = await ctx.tx.workSite.findMany({
    where: { tenantId: ctx.tenantId, isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true, code: true, name: true, latitude: true, longitude: true,
      radiusM: true, maxAccuracyM: true,
    },
  });

  return NextResponse.json({
    sites: sites.map((s) => ({
      ...s,
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
    })),
  });
});

const schema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Batas yang sama ditegakkan CHECK di basis data. Radius 50 km menerima seluruh
  // kota, dan geofence yang menerima seluruh kota tidak menilai apa pun.
  radiusM: z.number().int().min(20).max(5000).default(150),
  maxAccuracyM: z.number().int().min(10).max(1000).default(100),
});

export const POST = defineRoute('POST /api/attendance/work-sites', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data lokasi kerja tidak sah',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const created = await ctx.tx.workSite.create({
      data: {
        tenantId: ctx.tenantId,
        code: parsed.data.code.toLowerCase(),
        name: parsed.data.name,
        latitude: new Prisma.Decimal(parsed.data.latitude),
        longitude: new Prisma.Decimal(parsed.data.longitude),
        radiusM: parsed.data.radiusM,
        maxAccuracyM: parsed.data.maxAccuracyM,
      },
      select: { id: true },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(409, ErrorCode.CONFLICT, 'Kode lokasi sudah dipakai', ctx.correlationId);
    }
    throw error;
  }
});
