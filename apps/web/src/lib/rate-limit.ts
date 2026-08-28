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

/**
 * Kuota menyeluruh per tenant (PLAN/12 F6).
 *
 * Berbeda tujuan dari `rateLimit` per rute. Yang itu menjaga jalur tertentu
 * dari penyalahgunaan — coba-coba kata sandi, banjir pendaftaran. Yang ini
 * menjaga TETANGGA: satu tenant yang menjalankan skrip impor tanpa jeda tidak
 * boleh menghabiskan koneksi basis data dan membuat sembilan tenant lain
 * melihat aplikasinya berhenti merespons.
 *
 * Batasnya sengaja longgar. Ia bukan alat penagihan dan bukan pembatas
 * pemakaian wajar; ia hanya menangkap yang jelas keluar batas. Tenant seratus
 * karyawan yang seluruhnya presensi pada pukul delapan pagi menghasilkan
 * sekitar seratus permintaan dalam satu menit — dan itu harus lewat tanpa
 * hambatan, karena itulah hari kerja normal.
 *
 * Angkanya perlu dikalibrasi dengan data pilot. Sampai itu ada, yang lebih
 * penting daripada nilainya adalah bahwa pelanggarannya TERLIHAT: setiap
 * penolakan dicatat, sehingga batas yang salah setel ketahuan dari log alih-alih
 * dari keluhan pelanggan.
 */
const TENANT_QUOTA = { windowSeconds: 60, max: 600 } as const;

export interface QuotaOutcome {
  allowed: boolean;
  /** Sisa jatah pada jendela berjalan. Dikirim sebagai header. */
  remaining: number;
  /** Detik sampai jendela berikutnya. */
  resetSeconds: number;
}

export function consumeTenantQuota(tenantId: string): QuotaOutcome {
  const now = Date.now();
  sweep(now);

  const key = `tenant:${tenantId}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + TENANT_QUOTA.windowSeconds * 1000 });
    return {
      allowed: true,
      remaining: TENANT_QUOTA.max - 1,
      resetSeconds: TENANT_QUOTA.windowSeconds,
    };
  }

  const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

  if (bucket.count >= TENANT_QUOTA.max) {
    return { allowed: false, remaining: 0, resetSeconds };
  }

  bucket.count += 1;
  return { allowed: true, remaining: TENANT_QUOTA.max - bucket.count, resetSeconds };
}

export const TENANT_QUOTA_MAX = TENANT_QUOTA.max;
