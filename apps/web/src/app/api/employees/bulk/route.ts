import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { withTenant } from '@hrms/db';
import { bulkUpdateEmployees, BulkTooLargeError, MAX_BULK_ROWS } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fieldsSchema = z
  .object({
    employeeNumber: z.string().trim().min(1).max(32),
    fullName: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254).nullable(),
    phone: z.string().trim().max(32).nullable(),
    address: z.string().trim().max(500).nullable(),
    bankName: z.string().trim().max(64).nullable(),
    status: z.enum(['PROBATION', 'ACTIVE', 'RESIGNED', 'TERMINATED']),
    nationalId: z.string().trim().max(32).nullable(),
    taxId: z.string().trim().max(32).nullable(),
    bankAccount: z.string().trim().max(40).nullable(),
  })
  .partial();

const schema = z.object({
  changes: z
    .array(
      z.object({
        id: z.string().uuid(),
        version: z.number().int().min(0),
        fields: fieldsSchema,
      }),
    )
    .min(1)
    .max(MAX_BULK_ROWS),
});

/**
 * Menyimpan banyak perubahan karyawan sekaligus, dari grid ala Excel.
 *
 * Setiap baris disimpan dalam transaksinya sendiri lewat `withTenant`, sehingga
 * baris yang gagal tidak membatalkan yang berhasil. Alasannya ada di
 * `bulk-update.ts`; yang perlu diketahui di sini adalah bahwa respons ini
 * SELALU 200 selama permintaannya sah — kegagalan per baris ada di dalam
 * badannya, bukan pada kode statusnya.
 *
 * Klien wajib membaca `rows`. Menganggap 200 sebagai "semuanya tersimpan" akan
 * membuat baris yang gagal hilang tanpa jejak di layar.
 */
export const PATCH = defineRoute('PATCH /api/employees/bulk', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `Perubahan tidak sah atau melebihi ${MAX_BULK_ROWS} baris sekaligus.`,
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const result = await bulkUpdateEmployees(
      (work) => withTenant(ctx.tenantId, work),
      ctx.tenantId,
      parsed.data.changes,
      {
        actorUserId: ctx.userId,
        ip: ctx.ip ?? undefined,
        correlationId: ctx.correlationId,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BulkTooLargeError) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
