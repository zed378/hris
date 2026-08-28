import { NextResponse } from 'next/server';
import { ErrorCode } from '@hrms/contracts';
import { importDevicePunches, DeviceImportError } from '@hrms/core/attendance';
import { defineRoute, apiError } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sebulan ketukan untuk 500 karyawan sebagai CSV ≈ 2 MB. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Impor ketukan dari berkas ekspor mesin absensi.
 *
 * Satu endpoint dengan dua mode, bukan dua endpoint. `commit=false` mengurai dan
 * menghitung tanpa menulis apa pun; `commit=true` menulis. Berkasnya diunggah dua
 * kali, dan itu disengaja: menyimpan hasil pratinjau di server berarti menyimpan
 * data presensi mentah dalam keadaan setengah jadi, dengan masa hidup dan hak
 * akses tersendiri yang harus ikut dipikirkan.
 *
 * Penguraiannya deterministik dan penulisannya idempoten, jadi mengurai dua kali
 * menghasilkan hal yang sama dan mengirim dua kali tidak menggandakan apa pun.
 */
export const POST = defineRoute('POST /api/attendance/device-import', async (req, ctx) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'Permintaan harus berupa multipart/form-data berisi berkas.',
      ctx.correlationId,
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return apiError(400, ErrorCode.VALIDATION_FAILED, 'Berkas tidak ditemukan.', ctx.correlationId);
  }
  if (file.size > MAX_FILE_BYTES) {
    return apiError(
      400,
      ErrorCode.VALIDATION_FAILED,
      `Ukuran berkas ${Math.round(file.size / 1024 / 1024)} MB melebihi batas ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
      ctx.correlationId,
    );
  }

  // Default TIDAK menulis. Nilai yang hilang atau salah ketik akan menghasilkan
  // pratinjau, bukan impor — arah kegagalan yang benar untuk operasi yang
  // menyentuh dasar perhitungan gaji.
  const commit = form.get('commit') === 'true';

  try {
    const result = await importDevicePunches(
      ctx.tx,
      ctx.tenantId,
      { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) },
      ctx.userId,
      { commit },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeviceImportError) {
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, ctx.correlationId);
    }
    throw error;
  }
});
