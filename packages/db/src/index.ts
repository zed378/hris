// API publik paket @hrms/db.
//
// Impor dari jalur dalam (mis. '@hrms/db/src/client.ts') diblokir lint boundary.
// Batas ini yang membuat pemecahan modul menjadi service kelak murah (PLAN/12 §9).

export {
  appClient,
  workerClient,
  platformClient,
  disconnectAll,
  type PrismaClient,
} from './client.ts';
export {
  withTenant,
  withOutboxPump,
  catalog,
  InvalidTenantIdError,
  type TenantClient,
} from './tenant-context.ts';
export { writeAudit, type AuditEntry } from './audit.ts';
export { publishEvent, type OutboxEvent } from './outbox.ts';
export { Prisma } from '@prisma/client';
export type {
  Tenant,
  TenantModule,
  Module,
  Plan,
  User,
  RefreshToken,
  Role,
  Permission,
  Menu,
  UserPermissionGrant,
  AuditLog,
  OutboxMessage,
  Superuser,
  TenantStatus,
  TenantModuleStatus,
  ModuleTier,
  UserStatus,
  GrantEffect,
} from '@prisma/client';
