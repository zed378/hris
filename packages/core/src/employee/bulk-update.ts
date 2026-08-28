import type { TenantClient } from '@hrms/db';
import { updateEmployee, EmployeeError, type ActorContext } from './employees.ts';
import { MaskedValueError, InvalidIdentifierError } from './pii.ts';

/**
 * Penyuntingan massal dari grid ala Excel (PLAN/12 F2, risiko R6).
 *
 * Risiko R6 menyatakannya terus terang: adopsi gagal bila UI terasa lebih rumit
 * daripada Excel. HR yang sekarang mengubah lima puluh departemen dengan satu
 * tempel di spreadsheet tidak akan pindah ke sistem yang menuntut lima puluh
 * formulir — dan tidak ada pelatihan yang mengubah itu.
 *
 * Yang membuat berkas ini tidak sekadar perulangan atas `updateEmployee`:
 *
 * **Keberhasilan sebagian dilaporkan, bukan digagalkan seluruhnya.** Satu sel
 * salah di baris ke-37 tidak boleh membuang tiga puluh enam baris yang sudah
 * benar. Orang yang baru menempel dua ratus baris dari Excel tidak punya cara
 * mengulanginya, dan penolakan menyeluruh akan mendorongnya kembali ke Excel —
 * yaitu kegagalan yang justru hendak dicegah.
 *
 * Karena itu setiap baris ditulis dalam transaksinya sendiri. Yang hilang adalah
 * atomisitas seluruh operasi; yang didapat adalah pekerjaan orang tidak lenyap.
 * Pertukaran itu benar di sini karena tidak ada invarian lintas baris pada data
 * karyawan — mengubah departemen satu orang tidak bergantung pada yang lain.
 */

export interface BulkChange {
  id: string;
  /** Versi baris yang dilihat pengguna saat menyunting. Penjaga penulisan hilang. */
  version: number;
  fields: {
    employeeNumber?: string | undefined;
    fullName?: string | undefined;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    address?: string | null | undefined;
    bankName?: string | null | undefined;
    status?: 'PROBATION' | 'ACTIVE' | 'RESIGNED' | 'TERMINATED' | undefined;
    nationalId?: string | null | undefined;
    taxId?: string | null | undefined;
    bankAccount?: string | null | undefined;
  };
}

export interface BulkRowResult {
  id: string;
  ok: boolean;
  /** Versi baru bila berhasil, supaya grid dapat menyunting lagi tanpa memuat ulang. */
  version: number | null;
  error: string | null;
}

export interface BulkUpdateResult {
  saved: number;
  failed: number;
  rows: BulkRowResult[];
}

/**
 * Batas jumlah baris per permintaan.
 *
 * Tempelan dari Excel bisa sebesar apa pun, dan permintaan yang menyimpan lima
 * ribu baris akan menahan satu koneksi basis data selama menit-menit sementara
 * penggunanya menatap layar yang tidak bergerak. Klien memecahnya menjadi
 * beberapa permintaan; batas ini yang membuat pemecahan itu wajib.
 */
export const MAX_BULK_ROWS = 200;

export class BulkTooLargeError extends Error {
  constructor(readonly received: number) {
    super(`Terlalu banyak baris sekaligus: ${received}. Batasnya ${MAX_BULK_ROWS}.`);
    this.name = 'BulkTooLargeError';
  }
}

export async function bulkUpdateEmployees(
  runInTransaction: <T>(work: (tx: TenantClient) => Promise<T>) => Promise<T>,
  tenantId: string,
  changes: BulkChange[],
  ctx: ActorContext,
): Promise<BulkUpdateResult> {
  if (changes.length > MAX_BULK_ROWS) throw new BulkTooLargeError(changes.length);

  const rows: BulkRowResult[] = [];

  for (const change of changes) {
    // Baris tanpa perubahan dilewati tanpa menyentuh basis data. Grid mengirim
    // apa yang ditempel, dan tempelan hampir selalu memuat kolom yang nilainya
    // sama — menaikkan `version` untuk itu akan membuat penyuntingan berikutnya
    // ditolak sebagai "sudah diubah orang lain" tanpa ada yang mengubahnya.
    if (Object.keys(change.fields).length === 0) {
      rows.push({ id: change.id, ok: true, version: change.version, error: null });
      continue;
    }

    try {
      const result = await runInTransaction((tx) =>
        updateEmployee(tx, tenantId, change.id, change.version, change.fields, ctx),
      );
      rows.push({ id: change.id, ok: true, version: result.version, error: null });
    } catch (error) {
      rows.push({
        id: change.id,
        ok: false,
        version: null,
        error:
          error instanceof EmployeeError ||
          error instanceof MaskedValueError ||
          error instanceof InvalidIdentifierError
            ? error.message
            : error instanceof Error && error.message.includes('Unique constraint')
              ? 'Nomor karyawan sudah dipakai orang lain'
              : 'Baris ini gagal disimpan',
      });
    }
  }

  return {
    saved: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
  };
}
