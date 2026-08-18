import { z } from 'zod';

/**
 * Katalog event yang melewati outbox.
 *
 * Nama bertitik dan berbentuk lampau: sebuah event menyatakan sesuatu yang sudah
 * terjadi, bukan perintah untuk melakukan sesuatu. Perbedaan itu penting karena
 * event boleh diabaikan konsumen mana pun tanpa merusak penerbitnya (P3).
 */
export const EventTopic = {
  TENANT_PROVISIONED: 'tenant.provisioned',
  TENANT_MODULE_ENABLED: 'tenant.module.enabled',
  TENANT_MODULE_DISABLED: 'tenant.module.disabled',
  TENANT_SUSPENDED: 'tenant.suspended',

  USER_LOGGED_IN: 'auth.user.logged_in',
  USER_LOGIN_FAILED: 'auth.user.login_failed',
  SESSION_REVOKED: 'auth.session.revoked',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',

  ACCESS_CHANGED: 'iam.access.changed',
  ROLE_ASSIGNED: 'iam.role.assigned',
  USER_INVITED: 'iam.user.invited',

  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',

  EMPLOYEE_CREATED: 'employee.created',
  EMPLOYEE_IMPORT_COMMITTED: 'employee.import.committed',
  CONTRACT_EXPIRING: 'employee.contract.expiring',
} as const;

export type EventTopic = (typeof EventTopic)[keyof typeof EventTopic];

export const tenantProvisionedSchema = z.object({
  tenantId: z.string().uuid(),
  tenantCode: z.string(),
  planCode: z.string(),
  ownerUserId: z.string().uuid(),
});

export const tenantModuleChangedSchema = z.object({
  tenantId: z.string().uuid(),
  moduleCode: z.string(),
  actorUserId: z.string().uuid().nullable(),
});

export const userLoggedInSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export const accessChangedSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  newVersion: z.number().int(),
});

/** Peta topik → skema payload. Konsumer memvalidasi sebelum memproses. */
export const eventSchemas = {
  [EventTopic.TENANT_PROVISIONED]: tenantProvisionedSchema,
  [EventTopic.TENANT_MODULE_ENABLED]: tenantModuleChangedSchema,
  [EventTopic.TENANT_MODULE_DISABLED]: tenantModuleChangedSchema,
  [EventTopic.USER_LOGGED_IN]: userLoggedInSchema,
  [EventTopic.ACCESS_CHANGED]: accessChangedSchema,
} as const;
