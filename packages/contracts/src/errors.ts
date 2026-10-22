/**
 * API error codes and refusal reasons (docs/PLAN/15 §6, ADR-030, ADR-037).
 *
 * Stable and machine-readable. The frontend branches on these, never on the
 * message: the message is English prose for developers and may change, while a
 * code or a reason is a contract.
 */
export const ErrorCode = {
  /** Wrong credentials. Deliberately does not distinguish email, password, or tenant. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** A refresh token that was already rotated was used again — an indication of theft. */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  /**
   * The user's access changed after this token was issued (stale `av` claim).
   *
   * Not an error but an instruction: the client refreshes and retries, and the
   * user sees nothing. Distinct from TOKEN_EXPIRED so the logs can separate
   * "lifetime over" from "permissions changed" — two different investigations.
   */
  TOKEN_STALE: 'TOKEN_STALE',

  /** X-Tenant-ID disagrees with the token's claim. */
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',

  /** A role allows it, but the tenant does not subscribe to the module (P8). HTTP 402. */
  MODULE_NOT_SUBSCRIBED: 'MODULE_NOT_SUBSCRIBED',
  /** The module is subscribed, but the user does not hold the permission. HTTP 403. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /**
   * The actor may administer access but tried to confer more than they hold, or
   * to change the owner's access (P6-13). HTTP 403. `details.permissions` lists
   * what they lack, or `details.role` is `["TENANT_OWNER"]`.
   */
  PERMISSION_CEILING: 'PERMISSION_CEILING',

  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Refinements of `code` where one code covers refusals a user must be told
 * apart (ADR-037). Parameters travel in `details`, as string arrays.
 *
 * Login failures never carry a reason: `INVALID_CREDENTIALS` stays one
 * indistinguishable answer (`docs/SECURITY/02` §12).
 */
export const ErrorReason = {
  /** The signed-in user has no employee record (matched by email). */
  ACCOUNT_NOT_LINKED: 'ACCOUNT_NOT_LINKED',
  /** An invitation or password-reset link that is invalid, expired, or already used. */
  ACTION_TOKEN_INVALID: 'ACTION_TOKEN_INVALID',

  /** No file in the upload. */
  FILE_MISSING: 'FILE_MISSING',
  /** `details.maxBytes`. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** The file's CONTENTS are not an accepted type; renaming does not help. */
  FILE_TYPE_NOT_ACCEPTED: 'FILE_TYPE_NOT_ACCEPTED',

  /** A unique value is taken. `details.field`. */
  DUPLICATE_VALUE: 'DUPLICATE_VALUE',

  /** Policy BLOCK: `details.missing` ⊆ `location`, `photo`. */
  PUNCH_EVIDENCE_REQUIRED: 'PUNCH_EVIDENCE_REQUIRED',
  /** Policy FALLBACK_ONLY off the office network: `details.missing`. */
  PUNCH_EVIDENCE_REQUIRED_OFF_NETWORK: 'PUNCH_EVIDENCE_REQUIRED_OFF_NETWORK',
  /** The attendance period is closed: `details.period` (`MM/YYYY`). */
  ATTENDANCE_PERIOD_CLOSED: 'ATTENDANCE_PERIOD_CLOSED',
  /** The same punch was already recorded (offline replay). */
  PUNCH_DUPLICATE: 'PUNCH_DUPLICATE',

  LEAVE_INVALID_RANGE: 'LEAVE_INVALID_RANGE',
  LEAVE_ATTACHMENT_REQUIRED: 'LEAVE_ATTACHMENT_REQUIRED',
  /** The attachment is already claimed by another request. */
  LEAVE_ATTACHMENT_IN_USE: 'LEAVE_ATTACHMENT_IN_USE',
  /** `details.minServiceMonths`, `details.serviceMonths`. */
  LEAVE_NOT_ENTITLED: 'LEAVE_NOT_ENTITLED',
  LEAVE_NO_WORKING_DAYS: 'LEAVE_NO_WORKING_DAYS',
  /** `details.available`, `details.requested` (days). */
  LEAVE_INSUFFICIENT_BALANCE: 'LEAVE_INSUFFICIENT_BALANCE',
  LEAVE_OVERLAP: 'LEAVE_OVERLAP',
  /** The nominated approver does not hold `leave.request.approve`. */
  LEAVE_APPROVER_NOT_ELIGIBLE: 'LEAVE_APPROVER_NOT_ELIGIBLE',
  LEAVE_SELF_APPROVAL: 'LEAVE_SELF_APPROVAL',
  LEAVE_ALREADY_DECIDED: 'LEAVE_ALREADY_DECIDED',
} as const;

export type ErrorReason = (typeof ErrorReason)[keyof typeof ErrorReason];

export interface ApiError {
  error: {
    code: ErrorCode;
    /** English prose for developers and logs. Never shown to a user. */
    message: string;
    reason?: ErrorReason;
    /** Per-field validation details, or a reason's parameters. */
    details?: Record<string, string[]>;
    correlationId?: string;
  };
}
