/**
 * Pembacaan berkas ekspor mesin absensi (risiko R8, PLAN/04).
 *
 * Strateginya bukan menulis adapter per vendor. Merek mesin fingerprint yang
 * beredar di Indonesia terlalu banyak dan terlalu sering berganti firmware untuk
 * itu, dan tenant pertama yang memakai merek yang belum didukung akan berhenti
 * di hari pertama. Yang dipakai di sini adalah pengenalan kolom generik —
 * pendekatan yang sama dengan impor Excel karyawan, dan yang sama alasannya.
 *
 * Tiga bentuk yang benar-benar ditemui di lapangan:
 *
 *   1. Satu kolom tanggal-waktu   `PIN, DateTime, Status`
 *   2. Tanggal dan jam terpisah   `No. ID, Tanggal, Jam, Verifikasi`
 *   3. Tanpa kolom status         `UserID, Timestamp`   ← paling umum
 *
 * Bentuk ketiga menuntut keputusan yang tidak dapat dihindari: mesin hanya
 * mencatat KAPAN seseorang menempelkan jarinya, bukan apakah ia sedang datang
 * atau pulang. Aturannya ada di `inferPunchTypes`, dan alasannya di situ juga.
 */

export type DeviceColumn = 'employeeNumber' | 'dateTime' | 'date' | 'time' | 'status';

/**
 * Alias kolom, dinormalkan sebelum dibandingkan.
 *
 * Ditulis dalam bentuk yang sudah dinormalkan — tanpa spasi, tanpa titik, huruf
 * kecil. Impor karyawan pernah punya bug persis di sini: judul dinormalkan tetapi
 * aliasnya tidak, sehingga `E-Mail` tidak pernah cocok dengan alias `e-mail` dan
 * kolomnya diam-diam tidak terbaca.
 */
const ALIASES: Record<DeviceColumn, string[]> = {
  employeeNumber: [
    'pin',
    'userid',
    'user',
    'noid',
    'id',
    'nik',
    'nip',
    'employeeid',
    'employeeno',
    'nokaryawan',
    'idkaryawan',
    'badgenumber',
    'acnro',
    'acno',
  ],
  dateTime: [
    'datetime',
    'timestamp',
    'waktu',
    'tanggalwaktu',
    'checktime',
    'punchtime',
    'scantime',
    'logtime',
  ],
  date: ['date', 'tanggal', 'tgl', 'checkdate', 'workdate'],
  time: ['time', 'jam', 'waktuscan', 'checktimeonly'],
  status: ['status', 'state', 'verifikasi', 'verify', 'checktype', 'inout', 'keterangan', 'tipe'],
};

/** Membuang segala yang tidak membedakan judul kolom. */
function normalize(header: string): string {
  return header
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

export interface DeviceColumnMapping {
  /** Indeks kolom per peran. -1 berarti tidak ditemukan. */
  index: Record<DeviceColumn, number>;
  /** Peran wajib yang tidak ditemukan sama sekali. */
  missing: string[];
  /** Judul apa adanya, untuk ditampilkan kembali kepada pengguna. */
  headers: string[];
}

export function detectDeviceColumns(headers: string[]): DeviceColumnMapping {
  const index = {
    employeeNumber: -1,
    dateTime: -1,
    date: -1,
    time: -1,
    status: -1,
  } as Record<DeviceColumn, number>;

  headers.forEach((header, position) => {
    const key = normalize(header);
    if (key === '') return;

    for (const [role, aliases] of Object.entries(ALIASES) as Array<[DeviceColumn, string[]]>) {
      if (index[role] === -1 && aliases.includes(key)) {
        index[role] = position;
        return;
      }
    }
  });

  const missing: string[] = [];
  if (index.employeeNumber === -1) missing.push('nomor karyawan (PIN / User ID / NIK)');
  // Waktu boleh datang sebagai satu kolom atau sebagai tanggal + jam terpisah.
  if (index.dateTime === -1 && (index.date === -1 || index.time === -1)) {
    missing.push('waktu (kolom DateTime, atau kolom Tanggal dan Jam)');
  }

  return { index, missing, headers };
}

/**
 * Membaca satu sel waktu menjadi jam dinding lokal.
 *
 * Yang dikembalikan SENGAJA bukan `Date`. Berkas mesin absensi tidak membawa
 * zona waktu — angka `2026-08-10 08:05` di dalamnya berarti pukul delapan pagi
 * di tempat mesin itu terpasang, dan mengubahnya menjadi `Date` di sini akan
 * menafsirkannya memakai zona proses yang membaca berkas. Zona tenant baru
 * diterapkan satu lapis di atas, tempat zona itu diketahui.
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DATE_PATTERNS: Array<{ re: RegExp; order: 'ymd' | 'dmy' }> = [
  { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/, order: 'ymd' },
  { re: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/, order: 'dmy' },
];

export function parseWallClock(dateCell: unknown, timeCell?: unknown): WallClock | null {
  // Excel menyimpan tanggal sebagai Date bila selnya memang bertipe tanggal.
  if (dateCell instanceof Date && !Number.isNaN(dateCell.getTime())) {
    const base = {
      year: dateCell.getUTCFullYear(),
      month: dateCell.getUTCMonth() + 1,
      day: dateCell.getUTCDate(),
      hour: dateCell.getUTCHours(),
      minute: dateCell.getUTCMinutes(),
    };
    const time = timeCell === undefined ? null : parseTime(timeCell);
    return time ? { ...base, ...time } : base;
  }

  const raw = String(dateCell ?? '').trim();
  if (raw === '') return null;

  // Satu kolom yang memuat keduanya: "2026-08-10 08:05:00", "10/08/2026 08:05".
  const [datePart, ...restParts] = raw.split(/[\sT]+/);
  const inlineTime = restParts.join(' ');

  const date = parseDate(datePart ?? '');
  if (!date) return null;

  const time = parseTime(timeCell ?? inlineTime);
  if (!time) return null;

  return { ...date, ...time };
}

function parseDate(text: string): Pick<WallClock, 'year' | 'month' | 'day'> | null {
  for (const { re, order } of DATE_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;

    const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // `dmy` dipilih untuk format berpemisah dengan tahun di belakang karena
    // itulah yang dipakai perangkat lunak mesin absensi berbahasa Indonesia.
    // Menebak `mdy` akan menghasilkan tanggal yang SAH tetapi salah pada hari
    // 1 sampai 12 setiap bulan — kesalahan yang tidak menimbulkan galat apa pun.
    const year = order === 'ymd' ? a! : c!;
    const month = order === 'ymd' ? b! : b!;
    const day = order === 'ymd' ? c! : a!;

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }
  return null;
}

function parseTime(cell: unknown): Pick<WallClock, 'hour' | 'minute'> | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { hour: cell.getUTCHours(), minute: cell.getUTCMinutes() };
  }

  const text = String(cell ?? '').trim();
  if (text === '') return null;

  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

export type PunchType = 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';

/**
 * Menerjemahkan kolom status mesin, bila ada.
 *
 * Mengembalikan `null` bila selnya kosong atau tidak dikenali — dan `null` di
 * sini berarti "biarkan urutan yang memutuskan", bukan "anggap masuk". Menebak
 * IN untuk status yang tidak dikenali akan menghasilkan hari-hari dengan dua jam
 * masuk dan tanpa jam pulang, yang lalu dihitung sebagai nol menit kerja.
 */
export function parseStatus(cell: unknown): PunchType | null {
  const key = normalize(String(cell ?? ''));
  if (key === '') return null;

  // Angka: konvensi ZKTeco — 0 masuk, 1 pulang, 2/3 istirahat.
  if (/^\d+$/.test(key)) {
    const byCode: Record<string, PunchType> = {
      '0': 'IN',
      '1': 'OUT',
      '2': 'BREAK_START',
      '3': 'BREAK_END',
    };
    return byCode[key] ?? null;
  }

  // `cin`/`cout` berasal dari label "C/In" dan "C/Out" pada perangkat lunak
  // ZKTeco — bentuk yang paling sering muncul di berkas nyata, dan yang paling
  // mudah terlewat karena tidak terlihat seperti kata apa pun.
  if (['in', 'masuk', 'checkin', 'cin', 'datang', 'clockin', 'dutyon', 'i'].includes(key)) {
    return 'IN';
  }
  if (['out', 'pulang', 'checkout', 'cout', 'keluar', 'clockout', 'dutyoff', 'o'].includes(key)) {
    return 'OUT';
  }
  if (['breakout', 'obreak', 'istirahatmulai', 'mulaiistirahat'].includes(key)) {
    return 'BREAK_START';
  }
  if (['breakin', 'ibreak', 'istirahatselesai', 'selesaiistirahat'].includes(key)) {
    return 'BREAK_END';
  }

  return null;
}

export interface TimedPunch {
  /** Indeks baris di berkas, untuk menunjuk galat kembali ke selnya. */
  rowNumber: number;
  employeeNumber: string;
  wallClock: WallClock;
  /** Dari kolom status, bila mesinnya menyediakannya. */
  declaredType: PunchType | null;
}

/**
 * Menentukan jenis ketukan ketika mesin tidak menyatakannya.
 *
 * Ini keputusan yang tidak dapat dihindari, dan tidak ada jawaban yang benar
 * untuk semua kasus. Aturannya: **ketukan pertama pada satu hari kerja adalah
 * masuk, sisanya pulang.**
 *
 * Bukan berselang-seling (masuk, pulang, masuk, pulang). Berselang-seling terlihat
 * lebih pintar dan justru lebih rapuh: satu tempelan jari yang tidak terbaca
 * mesin — hal yang terjadi setiap hari — akan membalik SELURUH sisa hari itu,
 * mengubah jam pulang menjadi jam masuk dan menghasilkan jam kerja negatif yang
 * dibulatkan menjadi nol.
 *
 * Aturan pertama-masuk-sisanya-pulang tidak memiliki mode gagal seperti itu.
 * Kalkulasi harian sudah mengambil ketukan IN pertama dan OUT terakhir, sehingga
 * ketukan di tengah — makan siang, keluar sebentar — tidak mengubah apa pun,
 * dan tetap tersimpan utuh bila kelak dibutuhkan.
 */
export function inferPunchTypes(punches: TimedPunch[]): Array<TimedPunch & { type: PunchType }> {
  const seenFirst = new Set<string>();

  return [...punches]
    .sort((a, b) => compareWallClock(a.wallClock, b.wallClock))
    .map((punch) => {
      if (punch.declaredType) return { ...punch, type: punch.declaredType };

      // Kunci hari memakai tanggal kalender di berkas, bukan tanggal kerja.
      // Tanggal kerja butuh zona tenant dan aturan shift malam; yang dibutuhkan
      // di sini hanya "ketukan pertama orang ini pada hari itu".
      const key = `${punch.employeeNumber}|${punch.wallClock.year}-${punch.wallClock.month}-${punch.wallClock.day}`;
      if (!seenFirst.has(key)) {
        seenFirst.add(key);
        return { ...punch, type: 'IN' as const };
      }
      return { ...punch, type: 'OUT' as const };
    });
}

function compareWallClock(a: WallClock, b: WallClock): number {
  return (
    a.year - b.year ||
    a.month - b.month ||
    a.day - b.day ||
    a.hour - b.hour ||
    a.minute - b.minute
  );
}
