import type { NextResponse } from 'next/server';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import type { LeaveError } from '@hrms/core/leave';
import { apiError } from './define-route.ts';

/**
 * One mapping from a `LeaveError` to a response, for every leave route.
 *
 * The routes used to map it on their own, and disagreed. The decision route
 * answered a refused self-approval with 409, as if the request were in the
 * wrong state. It is a refusal of the actor, so it is a 403, which is how the
 * submit route already answered `forbidden`. The submit route in turn sent 403
 * with code `CONFLICT`. Status and code now agree. Which refusal it was
 * (`LEAVE_SELF_APPROVAL`, …) is `P6-24`'s `reason`.
 */
export function leaveErrorResponse(error: LeaveError, correlationId: string): NextResponse<ApiError> {
  switch (error.kind) {
    case 'not_found':
      return apiError(404, ErrorCode.NOT_FOUND, error.message, correlationId);
    case 'forbidden':
    case 'not_entitled':
      return apiError(403, ErrorCode.PERMISSION_DENIED, error.message, correlationId);
    // 409, not 400: the request is well-formed; the state of the system refuses
    // it. HR shown a 400 goes looking for a mistake in the form.
    case 'insufficient_balance':
    case 'overlap':
    case 'invalid_state':
      return apiError(409, ErrorCode.CONFLICT, error.message, correlationId);
  }
}
