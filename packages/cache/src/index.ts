// The public API of @hrms/cache.
//
// Redis-backed shared state: rate-limit counters today, and the permission cache
// the auth split needs (PLAN/14 §5 option C, §9.2). It lives in its own package
// because BOTH the backend and the auth service need it, and a copy in each
// would be two implementations of one limit — which is the same as no limit.

export {
  redis,
  redisReady,
  countInWindow,
  disconnectRedis,
  type WindowCount,
} from './redis.ts';

export {
  consumeRateLimit,
  consumeTenantQuota,
  rateLimitBackend,
  resetRateLimits,
  TENANT_QUOTA_MAX,
  type QuotaOutcome,
} from './rate-limit.ts';

export {
  readAccess,
  writeAccess,
  forgetUser,
  ACCESS_CACHE_TTL_SECONDS,
  readAccessVersion,
  writeAccessVersion,
  forgetAccessVersion,
  ACCESS_VERSION_TTL_SECONDS,
  readTenantGeneration,
  bumpTenantGeneration,
  resetAccessCache,
  type CachedAccess,
} from './access-cache.ts';
