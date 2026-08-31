-- =============================================================================
-- public.all_tenant_ids() — every tenant, not only the ones being billed
-- =============================================================================
--
-- `active_tenant_ids()` returns TRIAL and ACTIVE tenants, and it is right for
-- every job that has used it so far: there is no point accruing leave, sending
-- contract reminders, or running payroll for a tenant who has left.
--
-- PII key rotation is the first job for which that filter is a data-loss bug.
--
-- The rotation ends by REMOVING the old key from the environment. Any row not
-- converted before that moment becomes permanently unreadable — the ciphertext
-- remains, and nothing in the world can open it. Filtering by status means every
-- CHURNED tenant's national IDs, tax IDs, and bank accounts are quietly excluded
-- from the conversion and then destroyed by the cleanup step, while the job
-- reports success.
--
-- Measured on the development database before this function existed: the
-- rotation scanned **1** employee out of **7** holding encrypted values. The
-- other six belonged to CHURNED tenants. Nothing in the output said so.
--
-- That is also a legal problem, not only an operational one. A departed tenant's
-- employee records are still personal data under Act No. 27/2022: the tenant may
-- request an export, or request erasure and expect it to be demonstrable. "We
-- can no longer decrypt it" is not erasure — it is destruction by accident, and
-- it removes the ability to prove either that the data was deleted or that it
-- was not.
--
-- SECURITY DEFINER for the same reason as `active_tenant_ids()`: the worker role
-- is NOBYPASSRLS and cannot read `tenant.tenants` directly. The function returns
-- ids only — no names, no status, nothing that widens what a caller can learn.

CREATE OR REPLACE FUNCTION public.all_tenant_ids()
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id FROM tenant.tenants t
$$;

REVOKE ALL ON FUNCTION public.all_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.all_tenant_ids() TO hrms_worker;

COMMENT ON FUNCTION public.all_tenant_ids() IS
  'Every tenant regardless of status. For maintenance that must cover data at '
  'rest — PII key rotation above all, where skipping a churned tenant destroys '
  'its data when the old key is withdrawn. Scheduled business jobs should keep '
  'using active_tenant_ids().';
