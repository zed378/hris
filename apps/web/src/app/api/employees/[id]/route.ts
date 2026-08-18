import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { getEmployee, updateEmployee, EmployeeError } from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNMASK = 'employee.pii.unmask';

export const GET = defineRoute('GET /api/employees/[id]', async (_req, ctx) => {
  const id = ctx.params['id'];
  if (!id) return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id tidak ada', ctx.correlationId);

  try {
    return NextResponse.json(
      await getEmployee(ctx.tx, ctx.tenantId, id, ctx.access.permissions.includes(UNMASK)),
    );
  } catch (error) {
    if (error instanceof EmployeeError) {
      return apiError(404, ErrorCode.NOT_FOUND, error.message, ctx.correlationId);
    }
    throw error;
  }
});

const updateSchema = z.object({
  /** Wajib. Tanpa ini, dua penyunting saling menimpa tanpa ada yang tahu. */
  version: z.number().int().nonnegative(),
  fullName: z.string().trim().min(2).max(160).optional(),
  nationalId: z.string().trim().max(32).nullable().optional(),
  taxId: z.string().trim().max(32).nullable().optional(),
  bankAccount: z.string().trim().max(40).nullable().optional(),
  bankName: z.string().trim().max(64).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['PROBATION', 'ACTIVE', 'RESIGNED', 'TERMINATED']).optional(),
});

export const PATCH = defineRoute('PATCH /api/employees/[id]', async (req, ctx) => {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  const id = ctx.params['id'];
  if (!parsed.success || !id) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data perubahan tidak sah. Sertakan "version" dari data yang Anda baca.',
      ctx.correlationId,
    );
  }

  const { version, ...changes } = parsed.data;

  try {
    return NextResponse.json(
      await updateEmployee(ctx.tx, ctx.tenantId, id, version, changes, {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      }),
    );
  } catch (error) {
    if (error instanceof EmployeeError) {
      // 409 untuk konflik versi: klien harus memuat ulang, bukan mencoba lagi
      // dengan data yang sama.
      const status = error.kind === 'not_found' ? 404 : 409;
      const code = error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT;
      return apiError(status, code, error.message, ctx.correlationId);
    }
    throw error;
  }
});
