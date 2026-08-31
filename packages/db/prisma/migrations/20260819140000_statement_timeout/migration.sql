-- Query and idle transaction timeouts (PLAN/12 P6 — hardening).
--
-- What is protected here is not one query's performance but the availability of
-- the system for OTHER tenants.
--
-- One unindexed query sweeping millions of rows holds its connection until it
-- finishes. On a limited pool, a few such queries exhaust every connection, and
-- what stops working is not the tenant that ran them — it is everyone. The
-- failure looks like "the application is slow" with not one error, and its cause
-- is nearly impossible to find while it is happening.
--
-- The limits are set PER ROLE, not per connection, so no code path can forget
-- to apply them.

-- -----------------------------------------------------------------------------
-- hrms_app — serving user requests
-- -----------------------------------------------------------------------------
--
-- 15 seconds. A request longer than that has already failed from its user's
-- point of view: they have pressed reload, and the query still running only
-- holds a connection for a page they will never see.
--
-- The Excel export is the heaviest operation on this path, and 5,000 rows are
-- measured at about 2.5 seconds — six times below the limit.
ALTER ROLE hrms_app SET statement_timeout = '15s';

-- A transaction opened and then abandoned holds its locks forever.
--
-- This is what makes an attendance period close or a leave approval appear to
-- "hang": another transaction waits on a lock held by a transaction nobody is
-- continuing, because its process died halfway.
ALTER ROLE hrms_app SET idle_in_transaction_session_timeout = '30s';

-- The lock wait limit. Deliberately shorter than statement_timeout: failing fast
-- with "somebody else is working on this" is far more useful than hanging for
-- fifteen seconds and then failing with no explanation.
ALTER ROLE hrms_app SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- hrms_worker — the background process
-- -----------------------------------------------------------------------------
--
-- Far more generous, and that is exactly the difference: nobody is waiting in
-- front of a screen. A 5,000-employee import, the leave year-end close, and a
-- thousand-person payroll calculation all run here.
--
-- Still BOUNDED rather than unlimited. A job spinning forever because of one bug
-- still holds its connection, and the consequence for other tenants is the same.
-- tenant lain.
ALTER ROLE hrms_worker SET statement_timeout = '5min';
ALTER ROLE hrms_worker SET idle_in_transaction_session_timeout = '10min';
ALTER ROLE hrms_worker SET lock_timeout = '30s';

-- -----------------------------------------------------------------------------
-- hrms_platform — the platform admin portal
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_platform') THEN
    EXECUTE 'ALTER ROLE hrms_platform SET statement_timeout = ''30s''';
    EXECUTE 'ALTER ROLE hrms_platform SET idle_in_transaction_session_timeout = ''60s''';
    EXECUTE 'ALTER ROLE hrms_platform SET lock_timeout = ''10s''';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Schema drift checking
-- -----------------------------------------------------------------------------
--
-- Returns the `tenant_id` tables that have NO active RLS policy.
--
-- A CI gate checks the same thing, but CI only sees the schema built from the
-- migrations. What this function guards is the PRODUCTION database: someone
-- adding a table through psql on the night of an incident, or a migration that
-- failed halfway, produces a table without RLS that no CI will ever see.
--
-- A `tenant_id` table without RLS means every tenant reads every other tenant's
-- data. It raises no error, and nobody notices until someone sees data that is
-- not theirs.
--
CREATE OR REPLACE FUNCTION public.schema_drift_report()
RETURNS TABLE (
  kind        text,
  object_name text,
  detail      text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  -- 1. tenant_id tables with RLS off, or without FORCE.
  SELECT
    'rls_missing'::text,
    (c.table_schema || '.' || c.table_name)::text,
    CASE
      WHEN NOT t.relrowsecurity THEN 'RLS tidak aktif'
      WHEN NOT t.relforcerowsecurity THEN 'RLS aktif tetapi tidak FORCE'
    END::text
  FROM information_schema.columns c
  JOIN pg_class t ON t.relname = c.table_name
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = c.table_schema
  WHERE c.column_name = 'tenant_id'
    AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pgboss')
    AND t.relkind = 'r'
    AND (NOT t.relrowsecurity OR NOT t.relforcerowsecurity)

  UNION ALL

  -- 2. tenant_id tables where RLS is on but there is not one policy.
  --
  -- More dangerous than RLS being off: RLS on with no policy refuses EVERYTHING,
  -- so the module stops working entirely — and that looks like an application
  -- fault rather than a configuration problem.
  SELECT
    'policy_missing'::text,
    (n.nspname || '.' || t.relname)::text,
    'RLS aktif tetapi tidak punya kebijakan'::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relkind = 'r'
    AND t.relrowsecurity
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgboss')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = n.nspname AND c.table_name = t.relname
        AND c.column_name = 'tenant_id'
    )
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = n.nspname AND p.tablename = t.relname)

  UNION ALL

  -- 3. Application roles that can bypass RLS.
  --
  -- One `ALTER ROLE hrms_app BYPASSRLS` run "temporarily" while resolving an
  -- incident would stop the whole of tenant isolation applying, and not one test
  -- would catch it.
  SELECT
    'bypass_rls'::text,
    r.rolname::text,
    'Peran aplikasi dapat menembus RLS'::text
  FROM pg_roles r
  WHERE r.rolname IN ('hrms_app', 'hrms_worker', 'hrms_platform')
    AND r.rolbypassrls;
$$;

COMMENT ON FUNCTION public.schema_drift_report() IS
  'Menemukan tabel ber-tenant_id tanpa RLS, RLS tanpa kebijakan, dan peran aplikasi yang dapat menembus RLS. Dijalankan harian oleh worker.';

GRANT EXECUTE ON FUNCTION public.schema_drift_report() TO hrms_app, hrms_worker;
