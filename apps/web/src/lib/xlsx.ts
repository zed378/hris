import writeXlsxFile from 'write-excel-file/node';
import type { ExportResult } from '@hrms/core/reporting';

/**
 * Membungkus hasil ekspor menjadi respons .xlsx.
 *
 * Satu tempat untuk semua endpoint ekspor, dan itu bukan sekadar penghematan
 * baris: header `x-export-truncated` adalah janji yang harus dipenuhi semuanya.
 * Berkas yang terpotong diam-diam terlihat persis seperti berkas yang lengkap,
 * dan yang membacanya menyimpulkan sisanya memang tidak ada. Satu endpoint yang
 * lupa memasang header itu cukup untuk membatalkan janjinya.
 */
export async function xlsxResponse(
  result: ExportResult,
  options: { sheet: string; fileName: string; columnWidths?: number[] },
): Promise<Response> {
  const sheet = result.rows.map((row, index) =>
    row.map((value) => ({
      value,
      type: String,
      // Baris judul dibedakan supaya berkasnya dapat dibaca tanpa penjelasan.
      ...(index === 0 ? { fontWeight: 'bold' as const, backgroundColor: '#E8EEF9' } : {}),
    })),
  );

  const buffer = await writeXlsxFile(sheet as never, {
    sheet: options.sheet,
    columns: (options.columnWidths ?? result.rows[0]?.map(() => 18) ?? []).map((width) => ({
      width,
    })),
  }).toBuffer();

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${options.fileName}"`,
      'x-export-rows': String(result.rowCount),
      'x-export-truncated': String(result.truncated),
      // Berkas ini memuat data pribadi. Cache perantara mana pun yang
      // menyimpannya adalah salinan yang tidak diketahui siapa pun.
      'cache-control': 'no-store',
    },
  });
}
