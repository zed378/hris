/**
 * The route → module → permission map (PLAN/01 §5.2).
 *
 * This is P7 enforced: **no route without an explicit authorisation decision.**
 * A handler not registered here cannot be reached — not because someone forgot
 * to protect it, but because `defineRoute` refuses to run it.
 *
 * A deliberate consequence: adding an endpoint forces its author to answer two
 * questions before writing a line of logic — which module owns it, and which
 * permission guards it. Those are the most expensive questions to ask for the
 * first time once 200 routes exist.
 *
 * A CI test compares this file against the `route.ts` files on disk; either one
 * without its counterpart fails the build.
 */

export interface RouteRule {
  /** The owning module. If the tenant does not subscribe, the request is refused with 402 (P8). */
  module: string;
  /** The permission required. `null` means being authenticated is enough. */
  permission: string | null;
  /** No authentication at all. Only for the entry paths. */
  public?: boolean;
  /** A per-IP rate limit for guessable public paths. */
  rateLimit?: { windowSeconds: number; max: number };
}

export type RouteId = keyof typeof ROUTE_MANIFEST;

export const ROUTE_MANIFEST = {
  // --- Entry paths: public, but rate limited ------------------------------------
  // Login is deliberately limited hard. Without that, per-user account locking
  // becomes a weapon: an attacker can lock out an entire company's employees by
  // sending eight wrong passwords per account.
  'POST /api/auth/login': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 300, max: 20 },
  },
  'POST /api/auth/refresh': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 60, max: 30 },
  },
  'POST /api/auth/logout': {
    module: 'core',
    permission: null,
    public: true,
  },

  // --- Self-service registration ------------------------------------------------
  // Limited hard: every call creates a tenant, roles, and a user. Without a rate
  // limit this endpoint is the cheapest way to fill the database with junk
  // tenants.
  'POST /api/tenants/register': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 3600, max: 5 },
  },

  // --- Password reset & invitations ---------------------------------------------
  // All three are public because their users, by definition, cannot log in yet.
  // Their rate limits are tight: `forgot` sends email on our behalf, and an
  // unlimited email-sending endpoint is a spam tool that ruins a domain's reputation.
  'POST /api/auth/password/forgot': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 10 },
  },
  'POST /api/auth/password/reset': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 20 },
  },
  'POST /api/auth/invitation/accept': {
    module: 'core',
    permission: null,
    public: true,
    rateLimit: { windowSeconds: 900, max: 20 },
  },

  // --- Users, roles, and special access (PLAN/05 §7) ------------------------------
  // The `iam` module is CORE, so these endpoints are never closed by a
  // subscription — a tenant must always be able to manage its own users, whatever
  // its plan.
  'GET /api/users': { module: 'iam', permission: 'iam.user.read' },
  'POST /api/users': { module: 'iam', permission: 'iam.user.create' },
  'POST /api/users/from-employees': { module: 'iam', permission: 'iam.user.create' },
  'PUT /api/users/[id]/grants': { module: 'iam', permission: 'iam.grant.manage' },
  'DELETE /api/users/[id]/grants': { module: 'iam', permission: 'iam.grant.manage' },
  'GET /api/roles': { module: 'iam', permission: 'iam.role.read' },
  'GET /api/audit': { module: 'iam', permission: 'iam.audit.read' },
  'PUT /api/roles/[id]/permissions': { module: 'iam', permission: 'iam.role.manage' },

  // --- Employees (Phase 2) --------------------------------------------------------
  // The `employee` module is BASIC tier, so these endpoints refuse with 402 for a
  // tenant whose plan does not include it — even for a TENANT_OWNER (P8).
  'GET /api/employees': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/employees': { module: 'employee', permission: 'employee.employee.create' },
  'GET /api/employees/[id]': { module: 'employee', permission: 'employee.employee.read.all' },
  'PATCH /api/employees/[id]': { module: 'employee', permission: 'employee.employee.update' },
  'PATCH /api/employees/bulk': { module: 'employee', permission: 'employee.employee.update' },
  'GET /api/employees/[id]/documents': {
    module: 'employee',
    permission: 'employee.document.read',
  },
  'POST /api/employees/[id]/documents': {
    module: 'employee',
    permission: 'employee.document.manage',
  },
  // The basic permission everyone holds. The owner-vs-HR distinction happens
  // inside the handler — without that, an employee could not open the scan of
  // their own ID card, which is a right the Personal Data Protection Act guarantees.
  'GET /api/documents/[docId]': { module: 'employee', permission: 'employee.employee.read.own' },
  'DELETE /api/documents/[docId]': {
    module: 'employee',
    permission: 'employee.document.manage',
  },

  // Excel import — the migration path from the reference product, and the heart of
  // Gate A. The template uses the export permission, not the import one:
  // downloading a column sample is the first step before deciding to import.
  'GET /api/employees/template': { module: 'employee', permission: 'employee.export.execute' },
  'GET /api/employees/export': { module: 'employee', permission: 'employee.export.execute' },

  // Employment contracts. Fixed-term expiry reminders are why this module was
  // pulled forward into Phase 2: one contract that lapses becomes permanent by
  // operation of law, and that cannot be undone (document 08, A5).
  'GET /api/contracts/expiring': { module: 'employee', permission: 'employee.contract.read' },
  'POST /api/contracts': { module: 'employee', permission: 'employee.contract.manage' },
  'POST /api/employees/import': { module: 'employee', permission: 'employee.import.execute' },
  'GET /api/employees/import/[id]': { module: 'employee', permission: 'employee.import.execute' },
  'POST /api/employees/import/[id]/commit': { module: 'employee', permission: 'employee.import.execute' },

  // --- Organisational structure (Phase 2) -------------------------------------------
  'GET /api/org/departments': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/org/departments': { module: 'employee', permission: 'employee.employee.update' },
  'GET /api/org/positions': { module: 'employee', permission: 'employee.employee.read.all' },
  'POST /api/org/positions': { module: 'employee', permission: 'employee.employee.update' },
  'POST /api/org/placements': { module: 'employee', permission: 'employee.employee.update' },

  // --- Attendance (Phase 3) --------------------------------------------------------
  // Punching uses an `own`-scoped permission: an employee can only punch for
  // themselves, and `employeeId` is derived from the session — never from the
  // request body.
  'POST /api/attendance/punch': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'GET /api/attendance/me': { module: 'attendance', permission: 'attendance.record.read.own' },

  // Uploading a photo uses the ordinary punch permission; serving it checks a
  // second layer inside the handler — an ordinary employee may only see their own.
  'POST /api/attendance/photo': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'GET /api/attendance/photo/[key]': { module: 'attendance', permission: 'attendance.record.read.own' },

  // The review queue. A flagged punch is NOT refused automatically — it waits for
  // a human decision by someone who knows the context (P14).
  'GET /api/attendance/review': { module: 'attendance', permission: 'attendance.review.handle' },
  'POST /api/attendance/review': { module: 'attendance', permission: 'attendance.review.handle' },

  // Consent can only be given for oneself, so its permission is the basic punch
  // permission — not an administrative one. HR has no path to consent on anyone's
  // behalf, and that is the heart of the rule.
  // Dashboard scope is decided by permissions inside the handler, not by a
  // parameter. The manifest permission is therefore the basic one everyone holds.
  'GET /api/dashboard': { module: 'core', permission: 'core.dashboard.view.own' },
  // Tenant-wide by construction: there is no per-employee version of "the
  // flagged ratio across the company".
  'GET /api/dashboard/trends': { module: 'core', permission: 'core.dashboard.view.tenant' },

  // --- Health -----------------------------------------------------------------
  //
  // Neither uses defineRoute — see their route files. They are registered here
  // purely so the manifest coverage check does not report them as unregistered
  // routes (P7).
  // Public by definition: a JWKS exists to be fetched by anything that verifies
  // a token, and a public key discloses nothing. It is what lets a verifier
  // check a signature without holding anything that could produce one.
  'GET /api/.well-known/jwks.json': { module: 'core', permission: null, public: true },
  // Public in the manifest, and guarded by its own token inside the handler.
  // It cannot use a permission: Prometheus scrapes without a session, which is
  // the same reason /api/health is public.
  'GET /api/metrics': { module: 'core', permission: null, public: true },
  'GET /api/health': { module: 'core', permission: null, public: true },
  'GET /api/ready': { module: 'core', permission: null, public: true },

  // --- Subscription ------------------------------------------------------------
  //
  // Its module is `core`, not the module being managed. An endpoint that manages
  // a subscription must not die along with the module it is managing.
  'GET /api/subscription': { module: 'core', permission: 'core.settings.manage' },
  // Exporting all of a tenant's data — Personal Data Protection Act portability.
  //
  // Its rate limit is tight: one complete export reads every table the tenant
  // owns, and a button pressed repeatedly because the file is slow to appear
  // would run all of that reading several times at once.
  'GET /api/tenant/export': {
    module: 'core',
    permission: 'core.settings.manage',
    rateLimit: { windowSeconds: 3600, max: 5 },
  },
  'POST /api/subscription': { module: 'core', permission: 'core.settings.manage' },

  // --- Payroll -----------------------------------------------------------------
  'GET /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },
  'POST /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },
  // PUT validates a formula without saving it, used by the configuration screen
  // while an admin types. Its permission is the same as saving: whoever may know
  // which variables exist is whoever may configure them.
  'PUT /api/payroll/components': { module: 'payroll', permission: 'payroll.component.manage' },

  'GET /api/payroll/salary': { module: 'payroll', permission: 'payroll.salary.read' },
  'POST /api/payroll/salary': { module: 'payroll', permission: 'payroll.salary.manage' },

  'GET /api/payroll/runs': { module: 'payroll', permission: 'payroll.run.execute' },
  'GET /api/payroll/runs/export': { module: 'payroll', permission: 'payroll.run.execute' },
  'POST /api/payroll/runs': { module: 'payroll', permission: 'payroll.run.execute' },
  'GET /api/payroll/runs/[id]': { module: 'payroll', permission: 'payroll.run.execute' },
  // Approval is checked inside the handler with a separate permission: the person
  // who calculates and the person who approves should be different.
  'POST /api/payroll/runs/[id]': { module: 'payroll', permission: 'payroll.run.execute' },

  // The basic permission everyone holds; the own-vs-all distinction happens inside
  // the handler. Without it, an employee could not see their own payslip.
  'GET /api/payroll/payslips': { module: 'payroll', permission: 'payroll.payslip.read.own' },

  // --- Leave ---------------------------------------------------------------------
  // Notifications belong to no single module — they serve all of them. Placed in
  // the core module so subscribing does not require subscribing to any module.
  'GET /api/notifications/subscriptions': { module: 'core', permission: 'core.profile.read.own' },
  'POST /api/notifications/subscriptions': { module: 'core', permission: 'core.profile.read.own' },
  'DELETE /api/notifications/subscriptions': {
    module: 'core',
    permission: 'core.profile.read.own',
  },
  'GET /api/leave/types': { module: 'leave', permission: 'leave.request.create.own' },
  'POST /api/leave/types': { module: 'leave', permission: 'leave.policy.manage' },
  // List scope is decided by permissions inside the handler, not by a parameter:
  // a client asking for `all` without the permission receives its own list, not an error.
  // Readable by anyone who may request leave: everyone who can ask has to see
  // who can grant. The alternative was the screen listing every user in the
  // tenant, most of whom cannot approve anything.
  'GET /api/leave/approvers': { module: 'leave', permission: 'leave.request.create.own' },
  'GET /api/leave/requests': { module: 'leave', permission: 'leave.request.read.own' },
  'GET /api/leave/requests/export': { module: 'leave', permission: 'leave.request.read.all' },
  'POST /api/leave/requests': { module: 'leave', permission: 'leave.request.create.own' },
  'POST /api/leave/requests/[id]/decision': {
    module: 'leave',
    permission: 'leave.request.approve',
  },
  'DELETE /api/leave/requests/[id]/decision': {
    module: 'leave',
    permission: 'leave.request.create.own',
  },
  'POST /api/leave/attachments': { module: 'leave', permission: 'leave.request.create.own' },
  'GET /api/leave/attachments/[key]': {
    module: 'leave',
    // The basic permission; file ownership is checked inside its handler.
    permission: 'leave.request.read.own',
  },
  'GET /api/leave/balances': { module: 'leave', permission: 'leave.balance.read.own' },
  'POST /api/leave/balances': { module: 'leave', permission: 'leave.balance.manage' },

  'GET /api/attendance/live': { module: 'attendance', permission: 'attendance.record.read.all' },
  'GET /api/attendance/consent': { module: 'attendance', permission: 'attendance.punch.create.own' },
  'POST /api/attendance/consent': {
    module: 'attendance',
    permission: 'attendance.punch.create.own',
  },
  'POST /api/attendance/device-import': {
    module: 'attendance',
    permission: 'attendance.record.correct',
  },
  'POST /api/attendance/manual-punch': {
    module: 'attendance',
    permission: 'attendance.record.correct',
  },
  'GET /api/attendance/records': { module: 'attendance', permission: 'attendance.record.read.all' },
  'GET /api/reports/attendance-monthly': {
    module: 'attendance',
    permission: 'attendance.record.read.all',
  },
  'GET /api/attendance/records/export': {
    module: 'attendance',
    permission: 'attendance.record.read.all',
  },
  'POST /api/attendance/records': { module: 'attendance', permission: 'attendance.record.correct' },
  'GET /api/attendance/work-sites': { module: 'attendance', permission: 'attendance.record.read.own' },
  'POST /api/attendance/work-sites': { module: 'attendance', permission: 'attendance.shift.manage' },
  // Editing covers the office network list, which decides whose thin-evidence
  // punch is accepted under FALLBACK_ONLY. It is the same authority as drawing
  // the geofence, so it carries the same permission.
  'PATCH /api/attendance/work-sites/[id]': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'GET /api/attendance/policy': {
    module: 'attendance',
    // The attendance screen needs to know whether a photo is required BEFORE it asks for camera permission.
    permission: 'attendance.punch.create.own',
  },
  'PUT /api/attendance/policy': { module: 'attendance', permission: 'attendance.shift.manage' },
  'GET /api/attendance/holidays': {
    module: 'attendance',
    // Everyone needs to see them: the leave calendar displays them, and an employee
    // requesting leave needs to know which dates do not deduct from their balance.
    permission: 'attendance.record.read.own',
  },
  'POST /api/attendance/holidays': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'DELETE /api/attendance/holidays': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'GET /api/attendance/schedules': {
    module: 'attendance',
    permission: 'attendance.record.read.own',
  },
  'POST /api/attendance/schedules': {
    module: 'attendance',
    permission: 'attendance.shift.manage',
  },
  'GET /api/attendance/shifts': { module: 'attendance', permission: 'attendance.record.read.own' },
  'POST /api/attendance/shifts': { module: 'attendance', permission: 'attendance.shift.manage' },

  // --- Bootstrap --------------------------------------------------------------------
  // Requires no permission: every authenticated user is entitled to know what they
  // may see. Its contents are already filtered by effective access.
  'GET /api/me/bootstrap': {
    module: 'core',
    permission: null,
  },
} as const satisfies Record<string, RouteRule>;

export function lookupRoute(method: string, pathname: string): RouteRule | undefined {
  return ROUTE_MANIFEST[`${method} ${pathname}` as RouteId];
}

/**
 * A wide-typed view of the same manifest.
 *
 * The `as const satisfies` above gives literal-typed keys — that is what makes
 * `defineRoute('GET /api/typo')` fail to compile. As a side effect, optional
 * properties such as `rateLimit` appear only on the union members that have
 * them, so generic iteration over the manifest cannot reach them.
 *
 * Two shapes, one source: code naming a single route uses `ROUTE_MANIFEST`
 * (typo-safe), code iterating every route uses `ROUTE_RULES`.
 * `ROUTE_RULES`.
 */
export const ROUTE_RULES: Readonly<Record<string, RouteRule>> = ROUTE_MANIFEST;

/**
 * The control plane manifest.
 *
 * Separate from `ROUTE_MANIFEST` and carrying neither a `module` nor a
 * `permission` column: the admin plane knows nothing of subscriptions, and its
 * roles are not yet tiered. Merging the two into one table would tempt someone
 * into using `defineRoute` on an admin path — and at that moment a tenant token
 * becomes a key to the control plane.
 */
export interface AdminRouteRule {
  public?: boolean;
  rateLimit?: { windowSeconds: number; max: number };
}

export type AdminRouteId = keyof typeof ADMIN_ROUTE_MANIFEST;

export const ADMIN_ROUTE_MANIFEST = {
  'POST /admin/api/auth/login': {
    public: true,
    // Stricter than a tenant login. One account here holds every customer's
    // metadata, and those accounts can be counted on one hand.
    rateLimit: { windowSeconds: 900, max: 10 },
  },
  'GET /admin/api/tenants': {},
  'POST /admin/api/tenants': {},
  'GET /admin/api/tenants/detail': {},
  'POST /admin/api/tenants/status': {},
  'GET /admin/api/overview': {},
} as const satisfies Record<string, AdminRouteRule>;

export const ADMIN_ROUTE_RULES: Readonly<Record<string, AdminRouteRule>> = ADMIN_ROUTE_MANIFEST;
