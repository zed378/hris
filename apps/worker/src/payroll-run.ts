import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import {
  BATCH_SIZE,
  calculateBatch,
  failRun,
  finishRun,
  startRun,
  type BatchFailure,
} from '@hrms/core/payroll';

/**
 * Perhitungan payroll di worker (DoD Fase 5: 1.000 karyawan < 3 menit).
 *
 * Sebelumnya perhitungan berjalan di dalam transaksi permintaan HTTP, dan di
 * sana ia tidak dapat berhasil untuk perusahaan berukuran sedang: transaksi
 * interaktif Prisma dibatasi lima detik, `hrms_app` dibatasi
 * `statement_timeout` lima belas detik, dan run seribu karyawan melewati
 * keduanya. Yang terjadi bukan "lambat" — transaksinya dibatalkan, seluruh slip
 * yang sudah dihitung hilang, dan percobaan berikutnya mengulang dari nol lalu
 * gagal di detik yang sama. Run itu tidak akan pernah selesai.
 *
 * Di sini ia berjalan sebagai peran `hrms_worker` — `statement_timeout` lima
 * menit — dan yang lebih penting, **satu transaksi per potongan**. Kemajuan
 * ter-commit selagi berjalan, sehingga proses yang mati di potongan ketujuh
 * tidak menghapus enam potongan sebelumnya.
 */

export interface PayrollRunJobResult {
  runId: string;
  calculated: number;
  failed: number;
  batches: number;
  durationMs: number;
}

export async function runPayrollCalculation(
  tenantId: string,
  runId: string,
  actorUserId: string,
): Promise<PayrollRunJobResult> {
  const startedAt = Date.now();
  const client = workerClient();

  const { periodYear, periodMonth, pending } = await withTenant(
    tenantId,
    (tx) => startRun(tx, tenantId, runId),
    { client },
  );

  const failures: BatchFailure[] = [];
  let calculated = 0;
  let batches = 0;

  try {
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const slice = pending.slice(offset, offset + BATCH_SIZE);

      const result = await withTenant(
        tenantId,
        (tx) => calculateBatch(tx, tenantId, runId, slice, periodYear, periodMonth),
        // Batas transaksi dinaikkan dari lima detik bawaan Prisma. Lima puluh
        // karyawan tidak akan mendekati angka ini; batasnya ada supaya potongan
        // yang macet berhenti sebagai satu potongan, bukan menggantung
        // selamanya sambil memegang koneksi.
        { client, timeoutMs: 120_000 },
      );

      calculated += result.calculated;
      failures.push(...result.failures);
      batches += 1;

      // Dicatat per potongan, bukan hanya di akhir. Run seribu karyawan yang
      // diam selama tiga menit tidak dapat dibedakan dari run yang menggantung,
      // dan orang yang menunggunya akan me-restart worker tepat di tengah.
      log.info({
        scope: 'payroll-run',
        runId,
        tenantId,
        batch: batches,
        progress: `${calculated}/${pending.length}`,
      });
    }
  } catch (error) {
    // Kegagalan yang bukan per-karyawan: koneksi putus, tenant hilang. Run
    // ditandai FAILED supaya HR tahu ia boleh mencoba lagi — dan mencoba lagi
    // akan melanjutkan dari potongan terakhir yang ter-commit, bukan dari nol.
    await withTenant(
      tenantId,
      (tx) =>
        failRun(
          tx,
          tenantId,
          runId,
          error instanceof Error ? error.message : 'Perhitungan terhenti',
        ),
      { client },
    ).catch((nested: unknown) => {
      log.error({ scope: 'payroll-run', runId, tenantId, event: 'fail-mark-failed', error: nested });
    });

    throw error;
  }

  const result = await withTenant(
    tenantId,
    (tx) => finishRun(tx, tenantId, runId, failures, actorUserId),
    { client },
  );

  const durationMs = Date.now() - startedAt;
  log.info({
    scope: 'payroll-run',
    event: 'selesai',
    runId,
    tenantId,
    employeeCount: result.employeeCount,
    failed: failures.length,
    batches,
    durationMs,
  });

  return { runId, calculated, failed: failures.length, batches, durationMs };
}
