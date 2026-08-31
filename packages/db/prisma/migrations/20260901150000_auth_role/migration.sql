-- =============================================================================
-- hrms_auth — the role the auth service will connect as (PLAN/14 stage 5)
-- =============================================================================
--
-- Stage 5 of the split creates the database boundary BEFORE the network one, and
-- the order matters. A grant matrix is far easier to get right, and far cheaper
-- to correct, while everything still runs in one process and a mistake shows up
-- as a failing test rather than as a service that cannot start.
--
-- What this role may reach, and what it may not:
--
--   auth       users, refresh tokens, action tokens — credentials and sessions
--   iam        roles, permissions, menus, grants, access versions
--   tenant     tenants, plans, modules — because P8 is decided with the
--              permission check, not after it (PLAN/14 §4.1)
--   audit      append-only, like every other application role
--   messaging  the outbox: an auth event has to reach the same pump
--
--   employee, attendance, leave, payroll  — NOTHING. Not read, not written.
--
-- That last line is the point of the whole stage. The auth service is the one
-- component holding password hashes, and confining it to the schemas it needs
-- means a flaw in it cannot become a route to everyone's salary and national ID.
-- It is enforced by the ABSENCE of a grant plus `NOBYPASSRLS`, and asserted
-- positively by `packages/db/test/rls-coverage.test.ts` — a grant that appears
-- later by accident, through a broad `ALL TABLES` in some future migration, is
-- caught rather than assumed away.
--
-- ## What this migration deliberately does NOT do
--
-- It does not revoke the `auth` schema from `hrms_app`.
--
-- The clean end state is that the backend cannot read `auth.users` at all. Today
-- it must: `iam.administration` lists and invites users, `resolve-access` reaches
-- users to answer who holds a permission, and `notification`, `tenant`,
-- `reporting`, and `leave` all read the same table. Those call sites move to the
-- auth service in stage 6, together, because `iam` and `auth` are entangled by
-- design (PLAN/14 §4.1) — and revoking the grant before they move would take the
-- application down rather than tighten it.
--
-- Recorded here rather than left implicit, because a half-applied boundary that
-- nobody has written down reads, six months later, like a boundary.
--
-- ## NOLOGIN, like its siblings
--
-- The role carries no password. `ops/initdb/` grants LOGIN and a development
-- password on developer machines only, so production never inherits a credential
-- from git.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_auth') THEN
    CREATE ROLE hrms_auth NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- The same last fence as the other roles: if someone grants BYPASSRLS "to make
-- support easier", every deploy takes it back (risk R21).
ALTER ROLE hrms_auth NOBYPASSRLS;

GRANT USAGE ON SCHEMA tenant, auth, iam, audit, messaging TO hrms_auth;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA tenant, auth, iam, messaging
  TO hrms_auth;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tenant, auth, iam, audit, messaging
  TO hrms_auth;

-- The product catalogue is read-only for an application role. Adding a module or
-- a permission is a migration, never a runtime action.
REVOKE INSERT, UPDATE, DELETE ON tenant.modules, tenant.plans, tenant.plan_modules FROM hrms_auth;
REVOKE INSERT, UPDATE, DELETE ON iam.permissions, iam.menus FROM hrms_auth;

-- The audit trail only ever grows (P5).
GRANT SELECT, INSERT ON audit.audit_logs TO hrms_auth;
REVOKE UPDATE, DELETE ON audit.audit_logs FROM hrms_auth;

-- Tables added by later migrations are reachable without anyone remembering to
-- come back here. Their RLS policies are NOT automatic, deliberately, and a CI
-- gate refuses a tenant table without one.
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA tenant, auth, iam, messaging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA tenant, auth, iam, audit, messaging
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_auth;

-- The tenant context function, and the three SECURITY DEFINER resolvers that
-- exist for the flows where a token arrives without its tenant — login, refresh,
-- and the reset/invitation links. All four belong to the auth plane.
GRANT EXECUTE ON FUNCTION public.app_current_tenant() TO hrms_auth;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_by_code(text) TO hrms_auth;
GRANT EXECUTE ON FUNCTION public.resolve_refresh_token_owner(text) TO hrms_auth;
GRANT EXECUTE ON FUNCTION public.resolve_action_token_owner(text) TO hrms_auth;

-- Said out loud, though PostgreSQL grants nothing here by default: the control
-- plane is a different plane, not a role with more permissions (P11).
REVOKE ALL ON SCHEMA platform FROM hrms_auth;

COMMENT ON ROLE hrms_auth IS
  'The auth service (PLAN/14). Reaches auth, iam, tenant, audit, messaging and '
  'NOTHING in employee, attendance, leave, or payroll — the component holding '
  'password hashes must not also be a route to salaries and national IDs.';
