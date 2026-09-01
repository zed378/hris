/**
 * Downloads a file from an authenticated endpoint.
 *
 * Exists because `<a href="/api/…/export">` cannot work here. The browser follows
 * the link with a plain request that does not carry the `Authorization` header, and
 * every API in this app demands a Bearer token — so an export link that looks
 * correct always yields 401, and the failure appears as a corrupt file or a blank
 * page rather than a readable message.
 *
 * Equally important: because the response comes through `fetch`, its headers can
 * be read. The employee export returns `x-export-truncated` when the result exceeds
 * the row cap, and without this path there is nowhere to surface that to the user
 * — they download a file that appears complete.
 */

export interface DownloadOutcome {
  ok: boolean;
  /** Nama berkas yang benar-benar disimpan. */
  fileName: string;
  /** True if the server truncated its result for exceeding the row limit. */
  truncated: boolean;
  /** Number of rows included, if the server reports it. */
  rows: number | null;
  /** Message to display if the download failed. */
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
    return { ...empty, ok: false, error: 'Could not reach the server.' };
  }

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      ...empty,
      ok: false,
       error: json?.error?.message ?? `Download failed (HTTP ${response.status}).`,
    };
  }

  const blob = await response.blob();
  const fileName = fileNameFrom(response.headers.get('content-disposition'), fallbackName);

  // The object URL is revoked after the click fires. Without this, export files
  // remain held in tab memory until the page closes — and employee exports
  // contain personal data.
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Brief pause: some browsers cancel the download if the URL is revoked at the
    // same instant as the click.
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
 * Opens a file from an authenticated endpoint in a new tab.
 *
 * `window.open('/api/…')` suffers from exactly the same problem as
 * `<a href>`: the browser opens the URL with a request that carries no
 * `Authorization` header, and what appears in the new tab is a 401 JSON error —
 * not the document.
 *
 * The tab is opened FIRST, before `await`, then navigated after the file is
 * ready. Browsers block `window.open` called after an await because it is no
 * longer tied to the user's click, and that blockage appears as "nothing
 * happened" with no error message at all.
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
    return { ok: false, error: json?.error?.message ?? 'File could not be opened.' };
  }

  const url = URL.createObjectURL(await response.blob());
  if (tab) {
    tab.location.href = url;
  } else {
    // The popup blocker is the path that closes the one above. Opening in this
    // tab is better than failing silently.
    window.location.href = url;
  }

  // The object URL is revoked after the tab has had time to load it. Identity
  // documents are not left held in this page's memory longer than necessary.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, error: null };
}
