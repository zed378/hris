import { randomUUID } from 'node:crypto';
import { withTenant, catalog, writeAudit, publishEvent, Prisma } from '@hrms/db';
import { DEFAULT_LEAVE_TYPES, DEFAULT_PAYROLL_COMPONENTS, EventTopic } from '@hrms/contracts';

/**
 * Provisioning a new tenant.
 *
 * Under a microservices architecture this is a saga across four services with
 * compensation at every step (PLAN/06 §4.1): tenant-service creates the tenant,
 * auth-service creates the user, iam-service creates the roles — and if the
 * third step fails, the first two have to be undone through compensation events
 * that are written, tested, and monitored.
 *
 * Here it is one ACID transaction. If anything fails, everything is rolled back,
 * and there is no half-built tenant needing manual cleanup.
 *
 * This is the most concrete and least often counted benefit of a monolith: not
 * the saga code that need not be written, but the category of failure that need
 * not be monitored for the life of the product (PLAN/12 §10.1, R12).
 *
 * One detail is what makes it genuinely one transaction: **the tenant id is
 * generated in the application, not by the database.** The RLS policy on
 * `tenant.tenants` reads `id = app_current_tenant()`, so a new tenant row cannot
 * be inserted without a context — and the context cannot be set before the row
 * exists. Generating the id first breaks that circle: we set the context to an id
 * that does not exist yet, then insert the row that satisfies the policy exactly.
 * memenuhi kebijakannya.
 *
 * The first version broke it by inserting the tenant row outside the transaction
 * and deleting it again if a later step failed — one compensation step, precisely
 * the kind of code that should not need to exist in a monolith.
 */

/**
 * The system roles created for every new tenant.
 *
 * Their definitions deliberately live here rather than in the seed: the seed is
 * development data, while this is part of the product. A tenant registering at
 * three in the morning must get exactly the same roles as the demo tenant.
 */
const SYSTEM_ROLES = [
  { code: 'TENANT_OWNER', name: 'Pemilik Akun', scope: 'all' as const },
  { code: 'HR_ADMIN', name: 'Admin HR', scope: 'hr' as const },
  { code: 'DEPT_HEAD', name: 'Kepala Departemen', scope: 'team' as const },
  { code: 'LINE_MANAGER', name: 'Manajer Lini', scope: 'team' as const },
  { code: 'EMPLOYEE', name: 'Karyawan', scope: 'self' as const },
];

/** The permissions each role scope holds, as patterns over permission codes. */
const SCOPE_MATCHERS: Record<string, (code: string) => boolean> = {
  all: () => true,
  hr: (code) =>
    !code.startsWith('iam.role.manage') &&
    !code.startsWith('iam.grant.manage') &&
    !code.endsWith('.read.team') &&
    !code.startsWith('payroll.run.approve') &&
    !code.startsWith('payroll.statutory'),
  team: (code) =>
    code.endsWith('.own') ||
    code.endsWith('.team') ||
    code === 'leave.request.approve' ||
    code === 'core.dashboard.view.team',
  self: (code) => code.endsWith('.own'),
};

export class TenantCodeTakenError extends Error {
  constructor(code: string) {
    super(`Kode perusahaan "${code}" sudah dipakai`);
    this.name = 'TenantCodeTakenError';
  }
}

export interface ProvisionInput {
  tenantCode: string;
  companyName: string;
  ownerEmail: string;
  ownerFullName: string;
  /**
   * Already hashed by the caller, not a raw password.
   *
   * Two reasons. First, `auth` already imports `tenant` to resolve the code at
   * login; if `tenant` imported `auth` for hashing, the two would be a cycle —
   * workable in ESM, but fragile, and at a future split it would mean two
   * services calling each other. The application layer is the composition root,
   * and that is where the two should meet.
   *
   * Second, and more important: this function therefore never holds a raw
   * password at all.
   */
  ownerPasswordHash: string;
  planCode?: string;
}

export interface ProvisionResult {
  tenantId: string;
  tenantCode: string;
  ownerUserId: string;
  modules: string[];
  trialEndsAt: Date | null;
}

const TRIAL_DAYS = 14;

export async function provisionTenant(
  input: ProvisionInput,
  ctx: { ip?: string | undefined; correlationId?: string | undefined } = {},
): Promise<ProvisionResult> {
  const planCode = input.planCode ?? 'trial';
  const db = catalog();

  // The catalogue is read outside the tenant context: these tables are global and carry no RLS.
  const [plan, permissions] = await Promise.all([
    db.plan.findUnique({
      where: { code: planCode },
      select: { code: true, isActive: true, modules: { select: { moduleCode: true } } },
    }),
    db.permission.findMany({ select: { code: true } }),
  ]);

  if (!plan?.isActive) throw new Error(`Paket "${planCode}" tidak tersedia`);

  const trialEndsAt = planCode === 'trial' ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null;
  const tenantId = randomUUID();

  // The tenant code's uniqueness is not checked first with a SELECT, and that is
  // deliberate. Such a check cannot see through RLS, and even if it could it
  // would still leave a race between the check and the insert. The unique
  // constraint is the only correct check; what we need to do is translate its
  // error.
  try {
    return await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          code: input.tenantCode,
          name: input.companyName,
          planCode,
          status: 'TRIAL',
          trialEndsAt,
        },
        select: { id: true, code: true },
      });

      const modules = plan.modules.map((m) => m.moduleCode);

      await tx.tenantModule.createMany({
        data: modules.map((moduleCode) => ({
          tenantId: tenant.id,
          moduleCode,
          status: 'ENABLED' as const,
          enabledAt: new Date(),
        })),
      });

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const created = await tx.role.create({
          data: { tenantId: tenant.id, code: role.code, name: role.name, isSystem: true },
          select: { id: true },
        });
        roleIds.set(role.code, created.id);

        const matcher = SCOPE_MATCHERS[role.scope]!;
        const granted = permissions.filter((p) => matcher(p.code));
        await tx.rolePermission.createMany({
          data: granted.map((p) => ({
            tenantId: tenant.id,
            roleId: created.id,
            permissionCode: p.code,
          })),
        });
      }

      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.ownerEmail,
          fullName: input.ownerFullName,
          passwordHash: input.ownerPasswordHash,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: owner.id, roleId: roleIds.get('TENANT_OWNER')! },
      });
      await tx.accessVersion.create({
        data: { tenantId: tenant.id, userId: owner.id, version: 1 },
      });

      /**
       * The default configuration of the leave and payroll modules.
       *
       * Without it, a new tenant finds the leave module active with an EMPTY list
       * of leave types — nobody can request leave at all, and all that is visible
       * is a dropdown with no options — and a payroll module where every payslip
       * is zero rupiah because there is not one component. Both fail without an
       * error, and both block self-service onboarding on day one.
       *
       * Created inside the same provisioning transaction: a tenant born half
       * configured is a tenant that cannot be used, and fixing it later requires
       * somebody to know that it needs fixing.
       */
       */
      await tx.leaveType.createMany({
        data: DEFAULT_LEAVE_TYPES.map((type) => ({ tenantId: tenant.id, ...type })),
      });

      await tx.payrollComponent.createMany({
        data: DEFAULT_PAYROLL_COMPONENTS.map((component) => ({
          tenantId: tenant.id,
          ...component,
        })),
      });

      await writeAudit(tx, tenant.id, {
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenant.id,
        actorUserId: owner.id,
        after: { code: tenant.code, planCode, modules },
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      });

      await publishEvent(tx, tenant.id, {
        topic: EventTopic.TENANT_PROVISIONED,
        payload: {
          tenantId: tenant.id,
          tenantCode: tenant.code,
          planCode,
          ownerUserId: owner.id,
        },
        correlationId: ctx.correlationId,
      });

      return {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        ownerUserId: owner.id,
        modules: modules.sort(),
        trialEndsAt,
      };
    });
  } catch (error) {
    // Prisma 7 with a driver adapter does not fill in `meta.target` — the
    // constraint name is reported as "(not available)". So matching is done by
    // model, and that is still exact here: `tenant.tenants` has only two unique
    // indexes, `tenants_pkey` (id) and `tenants_code_key`, and its id is a UUID
    // we generated ourselves a moment ago.
    //
    // If a third unique index is ever added to this table, this matching becomes
    // wrong. The duplicate registration test is what will catch it.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      error.meta?.['modelName'] === 'Tenant'
    ) {
      throw new TenantCodeTakenError(input.tenantCode);
    }
    throw error;
  }
}
