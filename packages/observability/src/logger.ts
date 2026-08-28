/**
 * Log terstruktur (PLAN/12 F7 — observabilitas).
 *
 * Konvensi `{ scope: '…' }` sudah dipakai di seluruh basis kode sebelum berkas
 * ini ada. Yang ditambahkan di sini bukan konvensinya, melainkan empat hal yang
 * hilang darinya:
 *
 *   1. **Level**, sehingga log produksi dapat dikurangi tanpa mengubah kode.
 *   2. **Stempel waktu di dalam JSON.** Docker memang menambahkannya di luar,
 *      tetapi log yang dikirim ke agregator kehilangan lapisan itu — dan log
 *      tanpa waktu tidak dapat diurutkan terhadap log dari proses lain.
 *   3. **Correlation id**, supaya satu permintaan dapat ditelusuri melintasi
 *      lapisan.
 *   4. **Redaksi**, dan inilah yang paling menanggung beban.
 *
 * Tentang redaksi. Objek galat yang di-log apa adanya kerap membawa isi
 * permintaan yang menyebabkannya — dan pada sistem ini isi permintaan dapat
 * berupa NIK, nomor rekening, kata sandi, atau token akses. Log dikirim ke
 * agregator, disimpan berbulan-bulan, dan dapat dibaca lebih banyak orang
 * daripada basis datanya sendiri.
 *
 * Kebocoran lewat log tidak menghasilkan galat apa pun. Ia hanya menumpuk,
 * diam, sampai seseorang menyadari bahwa berkas log memuat data yang RLS
 * dijaga mati-matian untuk melindunginya.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Ambang level, dari `LOG_LEVEL`.
 *
 * Dibaca sekali saat modul dimuat, bukan setiap panggilan: log berada di jalur
 * panas, dan membaca variabel lingkungan puluhan ribu kali per menit adalah
 * biaya yang tidak dibayar apa pun.
 */
const threshold = LEVEL_ORDER[(process.env['LOG_LEVEL'] as LogLevel) ?? 'info'] ?? 20;

/**
 * Kunci yang isinya TIDAK PERNAH boleh masuk log.
 *
 * Dicocokkan pada nama kunci, bukan nilainya — pencocokan berbasis nilai akan
 * meleset pada data yang bentuknya tidak terduga, dan meleset di sini berarti
 * data pribadi tersimpan di agregator log.
 *
 * Daftarnya sengaja longgar: `password` menangkap `passwordHash` dan
 * `ownerPassword` sekaligus. Kelebihan redaksi hanya menyulitkan debugging;
 * kekurangan redaksi menyulitkan pemberitahuan pelanggaran data.
 */
const SENSITIVE = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'nationalid',
  'nik',
  'taxid',
  'npwp',
  'bankaccount',
  'rekening',
  'encrypted',
  'ciphertext',
  'totp',
  'photokey',
  'storagekey',
];

const REDACTED = '[disunting]';

/** Batas kedalaman. Objek melingkar dan struktur dalam tidak boleh membekukan proses. */
const MAX_DEPTH = 6;
/** Batas panjang string. Muatan besar di log menghabiskan kuota agregator. */
const MAX_STRING = 2_000;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE.some((needle) => lower.includes(needle));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[terlalu dalam]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[dipotong]` : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    // Larik panjang dipotong: seribu baris impor yang gagal tidak perlu seluruhnya
    // masuk log untuk dapat didiagnosis.
    const head = value.slice(0, 20).map((item) => redact(item, depth + 1));
    return value.length > 20 ? [...head, `…dan ${value.length - 20} lainnya`] : head;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Stack disertakan hanya pada level debug. Ia panjang, dan pada galat
      // yang sudah dikenali ia tidak menambah apa pun.
      ...(threshold <= LEVEL_ORDER.debug ? { stack: value.stack } : {}),
      ...(('code' in value) ? { code: (value as { code?: unknown }).code } : {}),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

export interface LogFields {
  scope: string;
  correlationId?: string | undefined;
  tenantId?: string | undefined;
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    ...(redact(fields) as Record<string, unknown>),
  };

  // `error` dan `warn` ke stderr, sisanya ke stdout. Pemisahan itu yang membuat
  // `docker logs` dan sebagian besar agregator dapat memisahkan sinyal dari
  // kebisingan tanpa mengurai isinya.
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (fields: LogFields): void => emit('debug', fields),
  info: (fields: LogFields): void => emit('info', fields),
  warn: (fields: LogFields): void => emit('warn', fields),
  error: (fields: LogFields): void => emit('error', fields),
};

/** Level yang sedang berlaku. Untuk endpoint diagnostik dan pengujian. */
export function currentLevel(): LogLevel {
  return (Object.entries(LEVEL_ORDER).find(([, v]) => v === threshold)?.[0] ?? 'info') as LogLevel;
}
