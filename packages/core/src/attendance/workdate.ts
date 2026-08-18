import type { TenantClient } from '@hrms/db';

/**
 * Batas hari kerja (dokumen 10 §3).
 *
 * Sebuah "hari kerja" adalah tanggal kalender di tempat orangnya bekerja, bukan
 * tanggal UTC pada saat yang sama. Perbedaannya tujuh sampai sembilan jam untuk
 * Indonesia, dan tujuh jam itu jatuh persis di pagi hari.
 *
 * Versi pertama menghitungnya dengan `getUTCHours()`. Untuk WIB (UTC+7) hasilnya:
 * setiap ketukan antara 06:00 dan 10:59 pagi mendarat pada tanggal KEMARIN.
 * Bukan kasus tepi — itu jendela kedatangan hampir semua orang. Setiap hari
 * kerja akan tampak sebagai pulang-tanpa-masuk, setiap harinya dihitung ABSENT,
 * dan setiap potongan gaji yang mengikutinya salah tanpa satu pun galat muncul.
 *
 * Ditulis tanpa pustaka zona waktu. `Intl.DateTimeFormat` sudah membawa basis
 * data IANA di dalam runtime, sehingga menambahkan date-fns-tz atau luxon hanya
 * menyalin data yang sudah ada — beserta kewajiban memperbaruinya.
 */

/** Ketukan sebelum jam ini dianggap milik hari kerja sebelumnya. */
const NIGHT_SHIFT_CUTOFF_HOUR = 4;

export interface ZonedParts {
  year: number;
  /** 1-12, bukan 0-11. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Memecah satu titik waktu menjadi bagian-bagian kalender pada zona tertentu.
 *
 * Memakai `formatToParts` alih-alih aritmetika offset karena offset sebuah zona
 * bukan konstanta: ia berubah saat DST, dan sudah beberapa kali berubah secara
 * permanen ketika sebuah negara mengganti aturannya. Indonesia memang tidak
 * memakai DST — tetapi tenant pertama yang berkantor di luar Indonesia akan
 * menemukan asumsi itu dengan cara yang mahal.
 */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  // `hour12: false` melaporkan tengah malam sebagai 24 pada sebagian runtime.
  const hour = value('hour') % 24;

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour,
    minute: value('minute'),
  };
}

/**
 * Menentukan tanggal kerja sebuah ketukan.
 *
 * Nilai kembaliannya adalah tengah malam UTC pada tanggal tersebut, karena itulah
 * bentuk yang dipakai kolom `date` PostgreSQL — sebuah tanggal tanpa waktu, bukan
 * sebuah titik waktu. Menyimpannya sebagai instan lokal akan membuat tanggal yang
 * sama berbeda nilainya tergantung siapa yang menuliskannya.
 */
export function resolveWorkDate(punchedAt: Date, timeZone: string): Date {
  const local = zonedParts(punchedAt, timeZone);

  // Ketukan dini hari milik shift yang dimulai kemarin malam. Ambangnya
  // diterapkan pada jam LOKAL — inilah satu-satunya perbedaan dari versi
  // sebelumnya, dan satu-satunya yang dibutuhkan.
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (local.hour < NIGHT_SHIFT_CUTOFF_HOUR) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return date;
}

/** `2026-08-10` pada zona yang diberikan. */
export function zonedDateString(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Selisih zona terhadap UTC pada satu titik waktu, dalam milidetik.
 *
 * Dihitung, bukan disimpan. Offset sebuah zona adalah fungsi dari waktunya —
 * `Asia/Jakarta` memang tetap +7 sepanjang tahun, tetapi zona lain tidak, dan
 * yang membedakan keduanya hanya basis data IANA di dalam runtime.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // Instan dibulatkan ke menit karena `zonedParts` juga hanya sampai menit.
  return asIfUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * Titik waktu untuk jam dinding lokal pada sebuah tanggal kerja.
 *
 * Dipakai untuk membandingkan ketukan dengan jadwal shift. `startMinute` sebuah
 * shift adalah menit sejak tengah malam LOKAL — shift pagi bernilai 480, dan 480
 * itu berarti pukul 08:00 di tempat orangnya bekerja, bukan 08:00 UTC.
 *
 * Menambahkannya langsung ke tengah malam UTC menggeser seluruh jadwal sebesar
 * offset zona: untuk WIB, shift pagi menjadi 15:00 sore, sehingga tidak ada
 * seorang pun yang pernah tercatat terlambat.
 *
 * Dua langkah karena offsetnya bergantung pada instan yang belum diketahui:
 * tebakan pertama memakai jam dinding sebagai UTC, lalu dikoreksi dengan offset
 * yang berlaku di sekitar hasil tebakan itu.
 */
export function localMinutesToInstant(
  workDateUtcMidnight: Date,
  minutesSinceMidnight: number,
  timeZone: string,
): Date {
  const wallClock = workDateUtcMidnight.getTime() + minutesSinceMidnight * 60_000;
  const firstGuess = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
  return new Date(wallClock - zoneOffsetMs(firstGuess, timeZone));
}

/**
 * Zona waktu tenant, dengan cadangan yang aman.
 *
 * `Asia/Jakarta` dipakai bila kolomnya kosong. Cadangan itu sengaja sebuah zona
 * nyata, bukan UTC: tenant yang barisnya belum terisi hampir pasti berada di
 * WIB, dan UTC akan mengulang persis kesalahan yang membuat kolom ini ada.
 */
export async function tenantTimeZone(tx: TenantClient, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { timezone: true },
  });
  return tenant?.timezone || 'Asia/Jakarta';
}
