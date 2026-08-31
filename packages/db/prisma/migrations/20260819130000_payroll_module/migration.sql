-- The Payroll module — structure (PLAN/12 P5, schema per document 02 §9).
--
-- What is built here is the FRAMEWORK only: salary components, period-based
-- salary structures, runs, payslips, and the calculation trace. The PPh21 and
-- BPJS rules are NOT in this migration and must not be added without Gate C
-- (document 12 §P5): a payroll expert engaged, 30 real payslips as test cases,
-- and spike S1 passing.
--
-- Two tables below decide most of whether this module is usable at all:
--
--   `statutory_configs` — tax and BPJS rates as date-versioned DATA, not
--   constants inside the code. Rates change through a ministerial regulation
--   issued in December and effective in January; a system that puts them in code
--   demands a deploy in the busiest week of the year, and cannot recompute last
--   month's payslip with the rate that applied then.
--
--   `calculation_traces` — the detail behind every figure on a payslip line.
--   When an employee challenges their pay, HR shows the breakdown instead of
--   arguing. Without it, the only answer to "why is my deduction this much" is

CREATE SCHEMA IF NOT EXISTS payroll;

CREATE TYPE payroll."ComponentType" AS ENUM (
  'EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFO'
);

CREATE TYPE payroll."CalcMethod" AS ENUM (
  'FIXED', 'FORMULA', 'PER_DAY', 'PER_HOUR', 'PERCENTAGE'
);

CREATE TYPE payroll."RunStatus" AS ENUM (
  'DRAFT', 'CALCULATING', 'CALCULATED', 'FAILED', 'PENDING_APPROVAL',
  'APPROVED', 'PAID', 'CANCELLED'
);

CREATE TYPE payroll."RunType" AS ENUM ('MONTHLY', 'THR', 'BONUS', 'ADJUSTMENT');

-- -----------------------------------------------------------------------------
-- Salary components
-- -----------------------------------------------------------------------------
CREATE TABLE payroll.components (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" payroll."ComponentType" NOT NULL,
    "calc_method" payroll."CalcMethod" NOT NULL,

    -- Filled according to `calc_method`: FIXED uses amount, FORMULA uses
    -- expression, PERCENTAGE uses rate over `base_component_code`.
    "amount" DECIMAL(18,2),
    "expression" TEXT,
    "rate" DECIMAL(9,6),
    "base_component_code" TEXT,

    -- Part of the tax and BPJS calculation base. Separated because not every
    -- allowance belongs to both, and either one alone changes the net pay.
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "bpjs_base" BOOLEAN NOT NULL DEFAULT false,

    -- The calculation order. A component using another's result must come after
    -- it; a cycle is refused by the application before the run starts.
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "components_tenant_id_code_key" ON payroll.components("tenant_id", "code");
CREATE INDEX "components_tenant_id_sort_order_idx" ON payroll.components("tenant_id", "sort_order");

-- Every method requires its own column to be filled.
--
-- Without this, a FORMULA component with no expression would produce zero on
-- every payslip — a figure that looks like a decision rather than an unfinished
-- configuration.
ALTER TABLE payroll.components
  ADD CONSTRAINT "components_method_complete" CHECK (
    ("calc_method" = 'FIXED' AND "amount" IS NOT NULL) OR
    ("calc_method" = 'FORMULA' AND "expression" IS NOT NULL) OR
    ("calc_method" = 'PERCENTAGE' AND "rate" IS NOT NULL AND "base_component_code" IS NOT NULL) OR
    ("calc_method" IN ('PER_DAY', 'PER_HOUR') AND "amount" IS NOT NULL)
  );

-- -----------------------------------------------------------------------------
-- Per-employee salary structure, period-based (P13)
-- -----------------------------------------------------------------------------
--
-- A row is closed, not overwritten. A July raise must not change a June payslip —
-- and the June payslip must remain recomputable with the figures that applied
-- then, for instance when an attendance correction arrives.
CREATE TABLE payroll.salary_structures (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,

    "amount" DECIMAL(18,2),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,

    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "salary_structures_tenant_employee_idx"
  ON payroll.salary_structures("tenant_id", "employee_id", "effective_from");

-- At most one CURRENT row per employee per component.
--
-- A partial unique index, not an application check: two raise requests arriving
-- at the same moment would both read "nothing is current".
CREATE UNIQUE INDEX "salary_structures_one_open_per_component"
  ON payroll.salary_structures("tenant_id", "employee_id", "component_id")
  WHERE "effective_to" IS NULL;

ALTER TABLE payroll.salary_structures
  ADD CONSTRAINT "salary_structures_period_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- -----------------------------------------------------------------------------
-- Versioned statutory configuration
-- -----------------------------------------------------------------------------
--
-- The PPh21 rates, PTKP, the BPJS wage ceilings, and their contribution
-- percentages are stored as DATA with an effective range — not as constants in
-- the code.
--
-- Two consequences make the difference concrete:
--
--   1. A rate change is applied through configuration, with no deploy (P5 DoD).
--   2. Last month's payslip can be recomputed with LAST MONTH's rate. A rate in
--      code knows only "now", so a December attendance correction recomputed in
--      January would use the new rate and produce a figure never on any payslip.
--
-- This table is deliberately EMPTY here. Filling it requires Gate C.
CREATE TABLE payroll.statutory_configs (
    "id" UUID NOT NULL,
    -- NULL means it applies to every tenant (the platform default).
    -- A tenant with a special case fills it with its own tenant_id.
    "tenant_id" UUID,
    -- PPH21_TER, PTKP, BPJS_KES, BPJS_JHT, BPJS_JP, BPJS_JKK, BPJS_JKM, UMR
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    -- The regulation it is based on. Mandatory: a tax figure with no legal basis
    -- cannot be defended under inspection.
    "legal_basis" TEXT NOT NULL,

    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statutory_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "statutory_configs_kind_effective_idx"
  ON payroll.statutory_configs("kind", "code", "effective_from");

ALTER TABLE payroll.statutory_configs
  ADD CONSTRAINT "statutory_configs_period_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- -----------------------------------------------------------------------------
-- Payroll runs
-- -----------------------------------------------------------------------------
CREATE TABLE payroll.payroll_runs (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_number" TEXT NOT NULL,
    "run_type" payroll."RunType" NOT NULL DEFAULT 'MONTHLY',

    "period_year" SMALLINT NOT NULL,
    "period_month" SMALLINT NOT NULL,
    "status" payroll."RunStatus" NOT NULL DEFAULT 'DRAFT',

    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "total_gross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_deduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(18,2) NOT NULL DEFAULT 0,

    "calculated_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "paid_at" TIMESTAMP(3),
    "last_error" TEXT,

    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_runs_tenant_id_run_number_key"
  ON payroll.payroll_runs("tenant_id", "run_number");

-- One run per tenant per period per type, cancelled ones aside.
--
-- This is what satisfies the DoD "running the same run twice produces exactly
-- one run". Enforced by the database, not by an application check: two clicks of
-- the "Calculate" button arriving together would both read "there is no run yet".
CREATE UNIQUE INDEX "payroll_runs_one_active_per_period"
  ON payroll.payroll_runs("tenant_id", "period_year", "period_month", "run_type")
  WHERE "status" <> 'CANCELLED';

ALTER TABLE payroll.payroll_runs
  ADD CONSTRAINT "payroll_runs_month_valid"
  CHECK ("period_month" BETWEEN 1 AND 12);

-- -----------------------------------------------------------------------------
-- Payslips and their lines
-- -----------------------------------------------------------------------------
CREATE TABLE payroll.payslips (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    "gross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,2) NOT NULL DEFAULT 0,

    -- A snapshot of the upstream data at calculation time: working days, days
    -- present, overtime hours, unpaid leave days. Stored so that recomputing from
    -- the same snapshot gives an identical result even if attendance changes later.
    "snapshot" JSONB NOT NULL,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payslips_run_id_employee_id_key"
  ON payroll.payslips("run_id", "employee_id");

CREATE INDEX "payslips_tenant_id_employee_id_idx"
  ON payroll.payslips("tenant_id", "employee_id");

CREATE TABLE payroll.payslip_lines (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,

    "component_code" TEXT NOT NULL,
    "component_name" TEXT NOT NULL,
    "type" payroll."ComponentType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payslip_lines_payslip_id_sort_order_idx"
  ON payroll.payslip_lines("payslip_id", "sort_order");

-- The component name and code are DENORMALISED onto the payslip line.
--
-- A payslip is a document that stands for years. Renaming a component from
-- "Tunjangan Transport" to "Tunjangan Transportasi" must not change a payslip
-- already issued — someone who printed it last year has to see the same words.

-- -----------------------------------------------------------------------------
-- The calculation trace
-- -----------------------------------------------------------------------------
--
-- One row per computed figure, holding the formula and its variable values.
-- When an employee challenges their pay, HR shows the breakdown instead of
-- arguing — and that is the difference between a dispute settled in five minutes
-- and a dispute that ends at the labour office.
CREATE TABLE payroll.calculation_traces (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "component_code" TEXT NOT NULL,

    -- The formula or method used, as it was.
    "expression" TEXT,
    -- The value of every variable at calculation time.
    "inputs" JSONB NOT NULL,
    "result" DECIMAL(18,2) NOT NULL,
    -- A one-sentence explanation to show the employee.
    "explanation" TEXT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calculation_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "calculation_traces_payslip_id_idx"
  ON payroll.calculation_traces("payslip_id");

-- -----------------------------------------------------------------------------
-- Foreign keys
-- -----------------------------------------------------------------------------
ALTER TABLE payroll.salary_structures
  ADD CONSTRAINT "salary_structures_component_id_fkey"
  FOREIGN KEY ("component_id") REFERENCES payroll.components("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE payroll.payslips
  ADD CONSTRAINT "payslips_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES payroll.payroll_runs("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE payroll.payslip_lines
  ADD CONSTRAINT "payslip_lines_payslip_id_fkey"
  FOREIGN KEY ("payslip_id") REFERENCES payroll.payslips("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE payroll.payslip_lines
  ADD CONSTRAINT "payslip_lines_component_id_fkey"
  FOREIGN KEY ("component_id") REFERENCES payroll.components("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE payroll.calculation_traces
  ADD CONSTRAINT "calculation_traces_payslip_id_fkey"
  FOREIGN KEY ("payslip_id") REFERENCES payroll.payslips("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Grants and RLS
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA payroll TO hrms_app, hrms_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA payroll
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA payroll
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payroll
  TO hrms_app, hrms_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA payroll TO hrms_app, hrms_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'components', 'salary_structures', 'payroll_runs',
    'payslips', 'payslip_lines', 'calculation_traces'
  ] LOOP
    EXECUTE format('ALTER TABLE payroll.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE payroll.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON payroll.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON payroll.%I USING (tenant_id = public.app_current_tenant()) WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- `statutory_configs` is different: its rows may belong to the platform
-- (tenant_id NULL) and are read by every tenant. Its policy therefore lets a
-- global row be READ by anyone, while only a tenant's own rows can be WRITTEN.
--
-- Without that separation, one tenant could change the PPh21 rate every other
-- tenant uses.
ALTER TABLE payroll.statutory_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.statutory_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payroll.statutory_configs;
CREATE POLICY tenant_isolation ON payroll.statutory_configs
  USING (tenant_id IS NULL OR tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());
