import { countInWindow, redis } from './redis.ts';

/**
 * Rate limiting, backed by Redis when there is one (PLAN/14 stage 3).
 *
 * The counters were process-local, and `PLAN/12` §3.1 justified that honestly:
 * one web process was the planned topology, and a `Map` is far cheaper than a
 * system to keep alive. What the original comment named as a future limit turned
 * out to be a present bug the moment anybody scales out — **each replica counts
 * alone**, so two replicas permit twice the configured rate and four permit four
 * times, with no error, no log, and no way to tell from the outside. The number
 * in the config is simply not the number in force.
 *
 * Horizontal scaling is one of the stated reasons for the service split, so that
 * failure would have arrived exactly when the system was busy enough to need the
 * limiter working.
 *
 * ## Redis is optional, and its absence is not a failure
 *
 * With no `REDIS_URL` this falls back to the in-process `Map` and behaves
 * precisely as before. That keeps every test, every local checkout, and every
 * single-container deployment working with nothing extra to run.
 *
 * ## When Redis is configured but unreachable
 *
 * The request is counted in memory instead, and it is **allowed** unless the
 * local count alone exceeds the limit. That is fail-open, deliberately, and it
 * is worth being explicit about:
 *
 *   - Failing closed would make a Redis outage a total outage. Nobody could log
 *     in, punch attendance, or approve anything, because a protective mechanism
 *     had a bad minute.
 *   - Failing open degrades to exactly the behaviour of the day before this
 *     change — several replicas each counting alone. It is a weaker limit, not
 *     an absent one.
 *
 * The degradation is logged once per outage rather than per request, so it is
 * visible without drowning the log in the middle of an incident.
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

function consumeLocal(key: string, max: number, windowSeconds: number): boolean {
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

export async function consumeRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const shared = await countInWindow(`rl:${key}`, windowSeconds);

  // `null` is "Redis had no opinion" — not configured, or not answering. The
  // local counter is the fallback, and it is the ONLY counter when Redis is
  // absent by design.
  if (shared === null) return consumeLocal(key, max, windowSeconds);

  return shared.count <= max;
}

/** Hanya untuk pengujian. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** True when a shared counter is in use, so the state is reportable. */
export function rateLimitBackend(): 'redis' | 'in-process' {
  return redis() ? 'redis' : 'in-process';
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

export async function consumeTenantQuota(tenantId: string): Promise<QuotaOutcome> {
  const shared = await countInWindow(`quota:${tenantId}`, TENANT_QUOTA.windowSeconds);

  if (shared !== null) {
    return {
      allowed: shared.count <= TENANT_QUOTA.max,
      remaining: Math.max(0, TENANT_QUOTA.max - shared.count),
      resetSeconds: Math.max(1, Math.ceil(shared.resetMs / 1000)),
    };
  }

  return consumeTenantQuotaLocally(tenantId);
}

function consumeTenantQuotaLocally(tenantId: string): QuotaOutcome {
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
