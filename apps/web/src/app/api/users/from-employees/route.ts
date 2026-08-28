import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EventTopic, ErrorCode } from '@hrms/contracts';
import { inviteEmployeesAsUsers, IamError } from '@hrms/core/iam';
import { issueActionToken } from '@hrms/core/auth';
import { publishEvent } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  /** Kosong berarti seluruh karyawan aktif yang belum punya akun. */
  employeeIds: z.array(z.string().uuid()).max(500).optional(),
  roleCode: z.string().trim().min(2).max(64).default('EMPLOYEE'),
});

/**
 * Mengundang karyawan menjadi pengguna, secara massal.
 *
 * HR mengimpor 100 karyawan, dan tidak satu pun dari mereka punya akun: mereka
 * tidak dapat masuk, mengetuk presensi, mengajukan cuti, atau melihat slip
 * gajinya. Sebelum endpoint ini, satu-satunya jalan adalah mengundang mereka
 * satu per satu lewat formulir yang meminta email dan nama yang **sudah ada**
 * di baris karyawannya.
 *
 * Untuk 100 orang itu 100 kali pengisian formulir dengan data yang sudah
 * dimiliki sistem — dan itu persis yang harus dilakukan tiga pilot Gerbang A
 * setelah berhasil mengimpor karyawannya.
 *
 * Undangan dan tokennya diterbitkan **di transaksi permintaan yang sama**.
 * Emailnya dikirim konsumer event, bukan di jalur ini: penyedia email yang
 * sedang bermasalah tidak boleh membuat seratus undangan gagal setengah jalan.
 */
export const POST = defineRoute('POST /api/users/from-employees', async (req, ctx) => {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Data tidak sah', ctx.correlationId);
  }

  try {
    const result = await inviteEmployeesAsUsers(
      ctx.tx,
      ctx.tenantId,
      {
        employeeIds: parsed.data.employeeIds,
        roleCode: parsed.data.roleCode,
      },
      {
        actorUserId: ctx.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
    );

    for (const invited of result.invited) {
      const token = await issueActionToken(ctx.tx, {
        tenantId: ctx.tenantId,
        userId: invited.userId,
        purpose: 'INVITATION',
        createdBy: ctx.userId,
        ip: ctx.ip,
      });

      await publishEvent(ctx.tx, ctx.tenantId, {
        topic: EventTopic.USER_INVITED,
        payload: {
          tenantId: ctx.tenantId,
          userId: invited.userId,
          email: invited.email,
          token: token.raw,
          expiresAt: token.expiresAt.toISOString(),
        },
        correlationId: ctx.correlationId,
      });
    }

    return NextResponse.json(
      {
        invited: result.invited.length,
        alreadyHasAccount: result.alreadyHasAccount,
        // Dikembalikan sebagai daftar, bukan sebagai angka. "12 karyawan tanpa
        // email" tidak dapat ditindaklanjuti; nama dan nomor karyawannya dapat.
        withoutEmail: result.withoutEmail,
        failed: result.failed,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof IamError) {
      return apiError(
        error.kind === 'not_found' ? 404 : 409,
        error.kind === 'not_found' ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT,
        error.message,
        ctx.correlationId,
      );
    }
    throw error;
  }
});
