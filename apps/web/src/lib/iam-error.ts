import type { NextResponse } from 'next/server';
import { ErrorCode, type ApiError } from '@hrms/contracts';
import type { IamError } from '@hrms/core/iam';
import { apiError } from './define-route.ts';

/**
 * One mapping from an `IamError` to a response, for every IAM route.
 *
 * Each route used to map it on its own, and they disagreed: the role and grant
 * routes answered every kind with 404, so a conflict read as "not found". The
 * permission ceiling (P6-13) adds a kind whose `details` the frontend needs, and
 * a fifth hand-written mapping is how one of them would have dropped them.
 */
export function iamErrorResponse(error: IamError, correlationId: string): NextResponse<ApiError> {
  switch (error.kind) {
    case 'ceiling':
      return apiError(403, ErrorCode.PERMISSION_CEILING, error.message, correlationId, error.details);
    case 'forbidden':
      return apiError(403, ErrorCode.PERMISSION_DENIED, error.message, correlationId);
    case 'conflict':
      return apiError(409, ErrorCode.CONFLICT, error.message, correlationId);
    case 'not_found':
      return apiError(404, ErrorCode.NOT_FOUND, error.message, correlationId);
  }
}
