import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import {
  listEmployees,
  createEmployee,
  EmployeeError,
  MaskedValueError,
  InvalidIdentifierError,
} from '@hrms/core/employee';
import { defineRoute, apiError } from '@/lib/define-route.ts';
import { Prisma } from '@hrms/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Izin membuka masking diperiksa di sini, bukan di dalam modul domain. */
const UNMASK = 'employee.pii.unmask';

export const GET = defineRoute('GET /api/employees', async (req, ctx) => {
  const url = new URL(req.url);
  return NextResponse.json(
    await listEmployees(ctx.tx, ctx.tenantId, {
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
      search: url.searchParams.get('search') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      departmentId: url.searchParams.get('departmentId') ?? undefined,
      // Daftar karyawan hampir selalu dibuka tanpa izin ini, dan itu jalur yang
      // benar: pada jalur tersamar tidak ada satu pun dekripsi yang terjadi.
      canUnmask: ctx.access.permissions.includes(UNMASK),
    }),
  );
});

const createSchema = z.object({
  employeeNumber: z.string().trim().min(1).max(32),
  fullName: z.string().trim().min(2).max(160),
  nationalId: z.string().trim().max(32).optional().nullable(),
  taxId: z.string().trim().max(32).optional().nullable(),
  bankAccount: z.string().trim().max(40).optional().nullable(),
  bankName: z.string().trim().max(64).optional().nullable(),
  bankAccountHolder: z.string().trim().max(160).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  birthDate: z.coerce.date().optional().nullable(),
  birthPlace: z.string().trim().max(120).optional().nullable(),
  gender: z.enum(['MALE', 'FEMALE']).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  joinDate: z.coerce.date(),
  status: z.enum(['PROBATION', 'ACTIVE', 'RESIGNED', 'TERMINATED']).optional(),
});

export const POST = defineRoute('POST /api/employees', async (req, ctx) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Data karyawan tidak lengkap atau tidak sah',
      ctx.correlationId,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  try {
    const created = await createEmployee(ctx.tx, ctx.tenantId, parsed.data, {
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      correlationId: ctx.correlationId,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    // Keunikan nomor karyawan dan NIK ditegakkan indeks unik, bukan cek-lalu-tulis.
    // Impor Excel menjalankan ratusan baris sekaligus; pemeriksaan mendahului
    // penyisipan selalu menyisakan celah balapan di antara keduanya.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError(
        409,
        ErrorCode.CONFLICT,
        'Nomor karyawan atau NIK sudah terdaftar',
        ctx.correlationId,
      );
    }
    if (error instanceof MaskedValueError || error instanceof InvalidIdentifierError) {
      // 400 dengan pesan aslinya: yang salah adalah nilai yang dikirim,
      // dan pesannya sudah menjelaskan cara memperbaikinya.
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    if (error instanceof EmployeeError) {
      return apiError(409, ErrorCode.CONFLICT, error.message, ctx.correlationId);
    }
    throw error;
  }
});
