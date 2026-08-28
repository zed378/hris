import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import {
  upsertComponent,
  availableVariables,
  checkFormula,
  ComponentError,
  AVAILABLE_FUNCTIONS,
} from '@hrms/core/payroll';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Komponen gaji.
 *
 * `GET` mengembalikan daftar komponen BESERTA variabel dan fungsi yang tersedia
 * bagi formula. Keduanya disertakan supaya layar konfigurasi dapat memandu
 * penulisan formula alih-alih membiarkan admin menebak nama variabel — dan
 * nama yang ditebak salah menghasilkan komponen yang ditolak saat disimpan.
 */
export const GET = defineRoute('GET /api/payroll/components', async (_req, ctx) => {
  const components = await ctx.tx.payrollComponent.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { sortOrder: 'asc' },
  });

  return NextResponse.json({
    components: components.map((component) => ({
      id: component.id,
      code: component.code,
      name: component.name,
      type: component.type,
      calcMethod: component.calcMethod,
      amount: component.amount === null ? null : Number(component.amount),
      expression: component.expression,
      rate: component.rate === null ? null : Number(component.rate),
      baseComponentCode: component.baseComponentCode,
      taxable: component.taxable,
      bpjsBase: component.bpjsBase,
      sortOrder: component.sortOrder,
      isActive: component.isActive,
    })),
    variables: await availableVariables(ctx.tx, ctx.tenantId),
    functions: AVAILABLE_FUNCTIONS,
  });
});

const schema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    // Kode komponen menjadi NAMA VARIABEL di dalam formula, sehingga ia harus
    // berbentuk identifier. Kode "TUNJANGAN-TRANSPOR" akan diurai parser sebagai
    // pengurangan dua variabel.
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Kode hanya boleh huruf, angka, dan garis bawah'),
  name: z.string().trim().min(2).max(120),
  type: z.enum(['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFO']),
  calcMethod: z.enum(['FIXED', 'FORMULA', 'PER_DAY', 'PER_HOUR', 'PERCENTAGE']),
  amount: z.number().nullable().optional(),
  expression: z.string().max(1000).nullable().optional(),
  rate: z.number().min(-10).max(10).nullable().optional(),
  baseComponentCode: z.string().max(32).nullable().optional(),
  taxable: z.boolean().default(true),
  bpjsBase: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const POST = defineRoute('POST /api/payroll/components', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Komponen gaji tidak lengkap.',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const saved = await upsertComponent(ctx.tx, ctx.tenantId, parsed.data, ctx.userId);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof ComponentError) {
      return apiError(
        error.kind === 'not_found' ? 404 : 400,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});

const checkSchema = z.object({ expression: z.string().max(1000), code: z.string().optional() });

/**
 * Memeriksa formula tanpa menyimpannya.
 *
 * Dipakai layar konfigurasi untuk memberi umpan balik saat admin mengetik.
 * Formula yang salah ditemukan saat run berarti ditemukan pada tanggal 25,
 * ketika seribu slip harus keluar besok pagi.
 */
export const PUT = defineRoute('PUT /api/payroll/components', async (req, ctx) => {
  const parsed = checkSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Ekspresi tidak ada.', ctx.correlationId);
  }

  const variables = await availableVariables(ctx.tx, ctx.tenantId, parsed.data.code);
  return NextResponse.json(checkFormula(parsed.data.expression, variables));
});
