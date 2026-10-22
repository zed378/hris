import type { NextResponse } from 'next/server';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import type { PunchError } from '@hrms/core/attendance';
import { apiError } from './define-route.ts';

/**
 * One mapping from a refused `PunchError` to a response, for every punch route.
 *
 * `duplicate` is not mapped here: it means the punch IS recorded, and each
 * route answers it as a success so the offline queue may drop it.
 *
 * - `locked` (closed period) is 409: retrying cannot change it, and a client
 *   given a 404 would think its punch was lost and try again.
 * - `blocked` (evidence the policy requires is missing) is 400: by the tenant's
 *   policy the request is incomplete. `reason` and `details.missing` say what
 *   is missing, for the frontend's own text (ADR-037).
 */
export function punchErrorResponse(error: PunchError, correlationId: string): NextResponse<ApiError> {
  switch (error.kind) {
    case 'locked':
      return apiError(409, ErrorCode.CONFLICT, error.message, correlationId, error.details, error.reason);
    case 'blocked':
      return apiError(400, ErrorCode.VALIDATION_FAILED, error.message, correlationId, error.details, error.reason);
    case 'duplicate':
      return apiError(409, ErrorCode.CONFLICT, error.message, correlationId, error.details, error.reason);
    case 'not_found':
      return apiError(404, ErrorCode.NOT_FOUND, error.message, correlationId, error.details, error.reason);
  }
}
