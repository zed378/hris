/**
 * Mengunduh berkas dari endpoint yang butuh otentikasi.
 *
 * Ada karena `<a href="/api/…/export">` tidak dapat bekerja di sini. Peramban
 * mengikuti tautan dengan permintaan biasa yang tidak membawa header
 * `Authorization`, dan seluruh API di aplikasi ini menuntut token Bearer —
 * sehingga tautan unduh yang terlihat wajar selalu menghasilkan 401, dan
 * kegagalannya muncul sebagai berkas rusak atau halaman kosong, bukan sebagai
 * pesan yang dapat dipahami.
 *
 * Ada manfaat kedua yang sama pentingnya: karena responsnya lewat `fetch`,
 * header dapat dibaca. Ekspor karyawan mengembalikan `x-export-truncated` ketika
 * hasilnya melebihi batas baris, dan tanpa jalur ini tidak ada satu pun tempat
 * yang dapat memberi tahu penggunanya — ia mengunduh berkas yang tampak lengkap.
 */

export interface DownloadOutcome {
  ok: boolean;
  /** Nama berkas yang benar-benar disimpan. */
  fileName: string;
  /** True bila server memotong hasilnya karena melebihi batas. */
  truncated: boolean;
  /** Jumlah baris yang disertakan, bila server menyebutkannya. */
  rows: number | null;
  /** Pesan untuk ditampilkan bila gagal. */
  error: string | null;
}

/** Mengambil nama berkas dari `content-disposition`, dengan cadangan. */
function fileNameFrom(header: string | null, fallback: string): string {
  const match = header ? /filename="?([^"]+)"?/.exec(header) : null;
  return match?.[1] ?? fallback;
}

export async function downloadFile(
  api: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  fallbackName: string,
): Promise<DownloadOutcome> {
  const empty = { fileName: fallbackName, truncated: false, rows: null };

  const response = await api(path).catch(() => null);
  if (!response) {
    return { ...empty, ok: false, error: 'Tidak dapat menghubungi server.' };
  }

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      ...empty,
      ok: false,
      error: json?.error?.message ?? `Unduhan gagal (HTTP ${response.status}).`,
    };
  }

  const blob = await response.blob();
  const fileName = fileNameFrom(response.headers.get('content-disposition'), fallbackName);

  // Objek URL dicabut setelah klik dijalankan. Tanpa itu, berkas ekspor tetap
  // tertahan di memori tab sampai halamannya ditutup — dan berkas ekspor
  // karyawan berisi data pribadi.
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Jeda singkat: sebagian peramban membatalkan unduhan bila URL-nya dicabut
    // pada saat yang sama dengan kliknya.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const rowsHeader = response.headers.get('x-export-rows');

  return {
    ok: true,
    fileName,
    truncated: response.headers.get('x-export-truncated') === 'true',
    rows: rowsHeader === null ? null : Number(rowsHeader),
    error: null,
  };
}

/**
 * Membuka berkas dari endpoint berotentikasi di tab baru.
 *
 * `window.open('/api/…')` mengalami persis masalah yang sama dengan
 * `<a href>`: peramban membuka URL itu dengan permintaan tanpa header
 * `Authorization`, dan yang muncul di tab baru adalah JSON 401 — bukan
 * dokumennya.
 *
 * Tab dibuka LEBIH DULU, sebelum `await`, lalu diarahkan setelah berkasnya
 * siap. Peramban memblokir `window.open` yang dipanggil setelah await karena
 * ia tidak lagi terhubung ke klik penggunanya, dan pemblokiran itu muncul
 * sebagai "tidak terjadi apa-apa" tanpa satu pun pesan.
 */
export async function openFile(
  api: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
): Promise<{ ok: boolean; error: string | null }> {
  const tab = window.open('', '_blank');

  const response = await api(path).catch(() => null);
  if (!response?.ok) {
    tab?.close();
    const json = (await response?.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return { ok: false, error: json?.error?.message ?? 'Berkas tidak dapat dibuka.' };
  }

  const url = URL.createObjectURL(await response.blob());
  if (tab) {
    tab.location.href = url;
  } else {
    // Pemblokir popup menutup jalur di atas. Membuka di tab ini lebih baik
    // daripada gagal diam-diam.
    window.location.href = url;
  }

  // Objek URL dicabut setelah tabnya sempat memuatnya. Dokumen identitas tidak
  // dibiarkan tertahan di memori halaman ini lebih lama dari perlunya.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, error: null };
}
