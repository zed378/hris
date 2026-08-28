import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { deletePhoto } from '@hrms/core/attendance';

/**
 * Penghapusan foto presensi yang melewati masa retensi (dokumen 10 §4.4).
 *
 * Sifat yang paling penting: **catatan presensinya tetap utuh.** Yang dihapus
 * hanya berkas fotonya dan rujukannya. Jam masuk, lokasi, jarak, dan skor
 * kepercayaan tetap ada — karena data itulah yang menjadi dasar perhitungan gaji,
 * dan slip gaji tahun lalu tidak boleh kehilangan dasarnya hanya karena fotonya
 * kedaluwarsa.
 *
 * Retensi bukan kerapian penyimpanan. UU PDP No. 27/2022 mensyaratkan data
 * pribadi tidak disimpan lebih lama dari keperluannya, dan foto wajah adalah
 * data pribadi yang keperluannya berakhir begitu presensi itu selesai ditinjau.
 */

export interface RetentionResult {
  tenants: number;
  deleted: number;
  /** Berkas yang memang sudah tidak ada. Wajar setelah pemulihan cadangan. */
  alreadyGone: number;
  failed: number;
}

/** Dibatasi per putaran supaya satu tenant dengan tunggakan besar tidak memblokir sisanya. */
const BATCH_LIMIT = 500;

export async function runPhotoRetention(): Promise<RetentionResult> {
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.active_tenant_ids()
  `;

  const result: RetentionResult = {
    tenants: tenants.length,
    deleted: 0,
    alreadyGone: 0,
    failed: 0,
  };
  const now = new Date();

  for (const { tenant_id: tenantId } of tenants) {
    try {
      const expired = await withTenant(
        tenantId,
        (tx) =>
          tx.punchLog.findMany({
            where: { tenantId, photoKey: { not: null }, photoExpiresAt: { lte: now } },
            take: BATCH_LIMIT,
            select: { id: true, photoKey: true },
          }),
        { client: workerClient() },
      );

      for (const punch of expired) {
        // Berkas dihapus lebih dulu, baru rujukannya.
        //
        // Urutan sebaliknya akan meninggalkan berkas yatim bila proses mati di
        // antaranya — foto yang tidak lagi terhubung ke catatan apa pun, dan
        // karenanya tidak akan pernah terhapus oleh putaran berikutnya.
        let outcome;
        try {
          outcome = await deletePhoto(punch.photoKey!);
        } catch (error) {
          // Rujukan basis data SENGAJA tidak dihapus. Selama ia bertahan,
          // putaran berikutnya akan menemukan berkas ini lagi. Menghapusnya
          // sekarang berarti berkas itu hilang dari pandangan sistem sementara
          // tetap ada di disk — persis kegagalan yang membuat janji retensi
          // 90 hari batal tanpa satu pun galat terlihat.
          result.failed += 1;
          log.error({ scope: 'photo-retention', punchId: punch.id, error });
          continue;
        }

        await withTenant(
          tenantId,
          (tx) =>
            tx.punchLog.update({
              where: { id: punch.id },
              data: { photoKey: null, photoExpiresAt: null },
            }),
          { client: workerClient() },
        );

        if (outcome.removed) result.deleted += 1;
        else result.alreadyGone += 1;
      }
    } catch (error) {
      result.failed += 1;
      log.error({ scope: 'photo-retention', tenantId, error });
    }
  }

  return result;
}
