import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { Prisma, writeAudit } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { ipRangesSchema } from '@/lib/cidr.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Editing a work site.
 *
 * Until now a site could only be created. A geofence is not a thing anyone gets
 * right on the first attempt — the coordinates come off a map, the radius is a
 * guess that the first week of flagged punches corrects, and the office network
 * is usually learned from IT after the site already exists. Without an edit path
 * the only fix was deleting and recreating, which orphans every punch already
 * pointing at that site.
 *
 * Every field is optional and only what is sent is written, so the screen can
 * save one field without resubmitting a form the user did not touch.
 */
const schema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radiusM: z.number().int().min(20).max(5000).optional(),
    maxAccuracyM: z.number().int().min(10).max(1000).optional(),
    ipRanges: ipRangesSchema.optional(),
    /**
     * Deactivating a site rather than deleting it (rule M4, document 09).
     *
     * Punches keep pointing at the site they were judged against. Deleting the
     * row would leave a recap that says a punch was 40 metres from somewhere
     * that no longer exists, and the reviewer looking at a disputed punch six
     * months later has no way to know what the fence was.
     */
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Tidak ada perubahan yang dikirim',
  });

export const PATCH = defineRoute(
  'PATCH /api/attendance/work-sites/[id]',
  async (req, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, 'Lokasi tidak disebut', ctx.correlationId);
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return apiError(
        400,
        ErrorCode.VALIDATION_FAILED,
        'Perubahan lokasi kerja tidak sah',
        ctx.correlationId,
        parsed.error.flatten().fieldErrors as Record<string, string[]>,
      );
    }

    const before = await ctx.tx.workSite.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: {
        code: true, name: true, latitude: true, longitude: true,
        radiusM: true, maxAccuracyM: true, ipRanges: true, isActive: true,
      },
    });

    if (!before) {
      return apiError(404, ErrorCode.NOT_FOUND, 'Lokasi kerja tidak ditemukan', ctx.correlationId);
    }

    const data = parsed.data;
    const updated = await ctx.tx.workSite.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.latitude !== undefined
          ? { latitude: new Prisma.Decimal(data.latitude) }
          : {}),
        ...(data.longitude !== undefined
          ? { longitude: new Prisma.Decimal(data.longitude) }
          : {}),
        ...(data.radiusM !== undefined ? { radiusM: data.radiusM } : {}),
        ...(data.maxAccuracyM !== undefined ? { maxAccuracyM: data.maxAccuracyM } : {}),
        ...(data.ipRanges !== undefined ? { ipRanges: data.ipRanges } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
      select: {
        id: true, code: true, name: true, latitude: true, longitude: true,
        radiusM: true, maxAccuracyM: true, ipRanges: true, isActive: true,
      },
    });

    /**
     * Audited, and the office networks are audited by their contents.
     *
     * A geofence decides who is recorded as absent, and an office network decides
     * whose thin-evidence punch is accepted. Widening either one quietly is the
     * cheapest way to make attendance evidence meaningless — a `/8` pasted into
     * the range list accepts sixteen million addresses, and nothing about the
     * screen afterwards looks different.
     */
    await writeAudit(ctx.tx, ctx.tenantId, {
      action: 'attendance.work_site.updated',
      entityType: 'work_site',
      entityId: id,
      actorUserId: ctx.userId,
      before: {
        name: before.name,
        latitude: Number(before.latitude),
        longitude: Number(before.longitude),
        radiusM: before.radiusM,
        maxAccuracyM: before.maxAccuracyM,
        ipRanges: before.ipRanges,
        isActive: before.isActive,
      },
      after: {
        name: updated.name,
        latitude: Number(updated.latitude),
        longitude: Number(updated.longitude),
        radiusM: updated.radiusM,
        maxAccuracyM: updated.maxAccuracyM,
        ipRanges: updated.ipRanges,
        isActive: updated.isActive,
      },
      ip: ctx.ip,
    });

    return NextResponse.json({
      ...updated,
      latitude: Number(updated.latitude),
      longitude: Number(updated.longitude),
    });
  },
);
