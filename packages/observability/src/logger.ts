/**
 * Structured logging (PLAN/12 P7 — observability).
 *
 * The `{ scope: '…' }` convention was already used across the codebase before
 * this file existed. What is added here is not the convention but the four
 * things missing from it:
 *
 *   1. **A level**, so production logging can be reduced without a code change.
 *   2. **A timestamp inside the JSON.** Docker adds one outside, but a log
 *      shipped to an aggregator loses that layer — and a log with no time
 *      cannot be ordered against logs from another process.
 *   3. **A correlation id**, so one request can be traced across layers.
 *   4. **Redaction**, and that is what carries the most weight.
   *   4. **Redaction**, and that is what carries the most weight.
 * On redaction. An error object logged as it is often carries the request body
 * that caused it — and in this system a request body can hold a national ID, a
 * bank account number, a password, or an access token. Logs are shipped to an
 * aggregator, kept for months, and readable by more people than the database
 * itself.
 *
 *
 * A leak through the logs produces no error at all. It simply accumulates,
 * silently, until someone notices that the log files hold the data RLS is
 * guarded so carefully to protect.
 */

import { currentContext } from './context.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The level threshold, from `LOG_LEVEL`.
 *
 * Read once when the module loads rather than on every call: logging is on the
 * hot path, and reading an environment variable tens of thousands of times a
 * minute is a cost nothing pays for.
 */
const threshold = LEVEL_ORDER[(process.env['LOG_LEVEL'] as LogLevel) ?? 'info'] ?? 20;

/**
 * Keys whose contents must NEVER reach a log.
 *
 * Matched on the key name, not its value — value-based matching misses data of
 * an unexpected shape, and a miss here means personal data stored in a log
 * aggregator.
 *
 * The list is deliberately loose: `password` catches `passwordHash` and
 * `ownerPassword` at once. Over-redacting only makes debugging harder;
 * under-redacting makes a breach notification harder.
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

/** The depth limit. A circular object or a deep structure must not freeze the process. */
const MAX_DEPTH = 6;
/** The string length limit. A large payload in a log burns the aggregator quota. */
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
    // A long array is truncated: a thousand failing import rows need not all be
    // in the log to be diagnosable.
    const head = value.slice(0, 20).map((item) => redact(item, depth + 1));
    return value.length > 20 ? [...head, `…dan ${value.length - 20} lainnya`] : head;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // The stack is included only at debug level. It is long, and on an error
      // that is already understood it adds nothing.
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

  /**
   * The request context is inserted automatically, and explicit fields WIN.
   *
   * The order is deliberate: a caller naming `correlationId` themselves — a
   * worker consumer forwarding it from the outbox envelope, for instance — is
   * recording the ORIGINATING request's correlation, not the correlation of the
   * process currently running. Overwriting it with the local context would break
   * the trail at exactly the boundary it is meant to join.
   */
  const context = currentContext();
  const record = {
    ts: new Date().toISOString(),
    level,
    ...(context ? { correlationId: context.correlationId, tenantId: context.tenantId } : {}),
    ...(redact(fields) as Record<string, unknown>),
  };

  // `error` and `warn` go to stderr, the rest to stdout. That separation is what
  // lets `docker logs` and most aggregators separate signal from noise without
  // parsing the contents.
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

/** The level currently in force. For a diagnostic endpoint and for testing. */
export function currentLevel(): LogLevel {
  return (Object.entries(LEVEL_ORDER).find(([, v]) => v === threshold)?.[0] ?? 'info') as LogLevel;
}
