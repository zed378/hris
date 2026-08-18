/**
 * Pembatas laju dalam memori.
 *
 * Cukup untuk satu proses web, dan satu proses web adalah topologi yang
 * direncanakan (PLAN/12 §3.1). Batasnya perlu dinyatakan jujur: saat `apps/web`
 * diskalakan menjadi lebih dari satu instance, setiap instance menghitung
 * sendiri dan batas efektifnya menjadi N kali lipat.
 *
 * Titik penggantinya sudah jelas — Redis atau tabel Postgres — dan pemicunya
 * adalah replika web kedua, bukan tebakan. Sampai saat itu, satu Map jauh lebih
 * murah daripada satu sistem tambahan yang harus dijaga hidup.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Pembersihan malas: entri kedaluwarsa dibuang saat kunci yang sama disentuh
// lagi, ditambah sapuan berkala agar Map tidak tumbuh karena IP yang tak kembali.
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function consumeRateLimit(key: string, max: number, windowSeconds: number): boolean {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }

  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** Hanya untuk pengujian. */
export function resetRateLimits(): void {
  buckets.clear();
}
