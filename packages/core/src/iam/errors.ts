/**
 * A refusal from the IAM administration functions.
 *
 * `ceiling` is the permission ceiling (`ceiling.ts`); its `details` say what the
 * actor lacked — `permissions` they do not hold, or `role: ['TENANT_OWNER']` —
 * so the frontend can explain the refusal without parsing the message.
 */
export class IamError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict' | 'forbidden' | 'ceiling',
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'IamError';
  }
}
