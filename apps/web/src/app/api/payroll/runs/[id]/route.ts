import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ErrorCode } from '@hrms/contracts';
import { PayrollError } from '@hrms/core/payroll';
import { EventTopic } from '@hrms/contracts';
import { publishEvent, writeAudit } from '@hrms/db';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APPROVE = 'payroll.run.approve';

export const GET = defineRoute('GET /api/payroll/runs/[id]', async (_req, ctx) => {
  const runId = ctx.params['id'];
  if (!runId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id run tidak ada', ctx.correlationId);
  }

  const run = await ctx.tx.payrollRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } });
  if (!run) return apiError(404, ErrorCode.NOT_FOUND, 'Run tidak ditemukan', ctx.correlationId);

  const payslips = await ctx.tx.payslip.findMany({
    where: { tenantId: ctx.tenantId, runId },
    orderBy: { createdAt: 'asc' },
    take: 2000,
    select: { id: true, employeeId: true, gross: true, deduction: true, net: true },
  });

  const employees = await ctx.tx.employee.findMany({
    where: { tenantId: ctx.tenantId, id: { in: payslips.map((p) => p.employeeId) } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  return NextResponse.json({
    run: {
      id: run.id,
      runNumber: run.runNumber,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      status: run.status,
      employeeCount: run.employeeCount,
      totalGross: Number(run.totalGross),
      totalDeduction: Number(run.totalDeduction),
      totalNet: Number(run.totalNet),
      lastError: run.lastError,
    },
    payslips: payslips.map((slip) => ({
      id: slip.id,
      employee: byId.get(slip.employeeId) ?? null,
      gross: Number(slip.gross),
      deduction: Number(slip.deduction),
      net: Number(slip.net),
    })),
  });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('calculate') }),
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('markPaid'), reference: z.string().trim().max(120).optional() }),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().min(4).max(500) }),
]);

/**
 * Tiga operasi pada satu run: hitung, setujui, batalkan.
 *
 * `calculate` melewati slip yang sudah ada, sehingga run yang terputus di
 * tengah dapat dilanjutkan tanpa menghasilkan slip ganda — DoD Fase 5.
 *
 * `approve` menuntut izin terpisah dari izin menjalankan run. Orang yang
 * menghitung dan orang yang menyetujui sebaiknya berbeda; sistem tidak
 * memaksakannya, tetapi memisahkan izinnya membuat pemisahan itu mungkin.
 */
export const POST = defineRoute('POST /api/payroll/runs/[id]', async (req, ctx) => {
  const runId = ctx.params['id'];
  if (!runId) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Id run tidak ada', ctx.correlationId);
  }

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Aksi tidak dikenal.', ctx.correlationId);
  }

  try {
    if (parsed.data.action === 'calculate') {
      /**
       * Perhitungan diserahkan ke worker, tidak dijalankan di sini.
       *
       * Bukan demi kerapian. Transaksi interaktif Prisma dibatasi lima detik
       * dan peran `hrms_app` dibatasi `statement_timeout` lima belas detik;
       * run seribu karyawan melewati keduanya. Yang terjadi bukan permintaan
       * yang lambat — transaksinya dibatalkan, SELURUH slip yang sudah dihitung
       * hilang, dan percobaan berikutnya mengulang dari nol lalu gagal di detik
       * yang sama. Run itu tidak akan pernah selesai.
       *
       * Statusnya ditandai CALCULATING di sini, dalam transaksi yang sama
       * dengan penerbitan event. Menandainya di worker akan meninggalkan
       * jendela ketika HR sudah menekan tombol tetapi layar masih menampilkan
       * DRAFT — dan yang dilakukan orang pada jendela itu adalah menekan tombol
       * lagi.
       */
      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (!run) {
        return apiError(404, ErrorCode.NOT_FOUND, 'Run tidak ditemukan', ctx.correlationId);
      }
      if (run.status !== 'DRAFT' && run.status !== 'FAILED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          run.status === 'CALCULATING'
            ? 'Run ini sedang dihitung. Muat ulang halaman untuk melihat kemajuannya.'
            : `Run berstatus ${run.status} tidak dapat dihitung ulang. Batalkan dan buat run baru.`,
          ctx.correlationId,
        );
      }

      await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'CALCULATING', lastError: null },
      });

      await publishEvent(ctx.tx, ctx.tenantId, {
        topic: EventTopic.PAYROLL_RUN_REQUESTED,
        payload: { tenantId: ctx.tenantId, runId, actorUserId: ctx.userId },
      });

      // 202, bukan 200. Perhitungannya belum terjadi, dan mengembalikan 200
      // dengan angka nol akan terbaca sebagai "seribu karyawan, nol rupiah".
      return NextResponse.json(
        {
          runId,
          status: 'CALCULATING',
          message:
            'Perhitungan dijalankan di latar belakang. Muat ulang halaman untuk melihat kemajuannya.',
        },
        { status: 202 },
      );
    }

    if (parsed.data.action === 'approve') {
      if (!ctx.access.permissions.includes(APPROVE)) {
        return apiError(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Persetujuan run membutuhkan izin tersendiri.',
          ctx.correlationId,
        );
      }

      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (run?.status !== 'CALCULATED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          `Hanya run yang sudah dihitung dapat disetujui. Status saat ini: ${run?.status ?? 'tidak ada'}.`,
          ctx.correlationId,
        );
      }

      const approved = await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: ctx.userId },
        select: { id: true, status: true },
      });
      return NextResponse.json(approved);
    }

    if (parsed.data.action === 'markPaid') {
      /**
       * Menandai gaji sudah benar-benar dibayarkan.
       *
       * Status `PAID` dan kolom `paid_at` ada sejak modul payroll dibangun, dan
       * dua jalur baca memeriksanya — dasbor dan daftar slip keduanya
       * memperlakukan `APPROVED` dan `PAID` sebagai "sudah dirilis". Tetapi
       * **tidak ada satu pun jalur yang menghasilkannya**, pola yang sama dengan
       * `LEAVE`, `MANUAL`, `DISCARDED`, dan status tenant.
       *
       * Yang hilang bukan kosakata. Persetujuan dan pembayaran adalah dua
       * peristiwa berbeda yang sering terpisah berhari-hari: run disetujui
       * tanggal 25, transfer bank dieksekusi tanggal 28. Tanpa pembedaan itu,
       * pertanyaan "apakah gaji bulan lalu sudah benar-benar keluar" tidak punya
       * jawaban di dalam sistem — dan pertanyaan itu datang dari karyawan yang
       * uangnya belum masuk.
       *
       * Izinnya sama dengan menyetujui: yang berhak melepas run adalah yang
       * berhak menyatakan uangnya sudah keluar.
       */
      if (!ctx.access.permissions.includes(APPROVE)) {
        return apiError(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Menandai run terbayar membutuhkan izin persetujuan run.',
          ctx.correlationId,
        );
      }

      const run = await ctx.tx.payrollRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (run?.status !== 'APPROVED') {
        return apiError(
          409,
          ErrorCode.CONFLICT,
          `Hanya run yang sudah disetujui dapat ditandai terbayar. Status saat ini: ${run?.status ?? 'tidak ada'}.`,
          ctx.correlationId,
        );
      }

      const paid = await ctx.tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'PAID', paidAt: new Date() },
        select: { id: true, status: true, paidAt: true },
      });

      await writeAudit(ctx.tx, ctx.tenantId, {
        action: 'payroll.run.paid',
        entityType: 'payroll_run',
        entityId: runId,
        actorUserId: ctx.userId,
        correlationId: ctx.correlationId,
        after: { paidAt: paid.paidAt, reference: parsed.data.reference ?? null },
      });

      return NextResponse.json(paid);
    }

    // Pembatalan. Slipnya TIDAK dihapus — run yang dibatalkan tetap dapat
    // diperiksa, dan indeks unik parsial mengecualikan status CANCELLED
    // sehingga periode itu terbuka kembali untuk run baru.
    const cancelled = await ctx.tx.payrollRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', lastError: `Dibatalkan: ${parsed.data.reason}` },
      select: { id: true, status: true },
    });
    return NextResponse.json(cancelled);
  } catch (error) {
    if (error instanceof PayrollError) {
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
