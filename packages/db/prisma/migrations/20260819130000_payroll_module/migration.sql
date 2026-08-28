-- Modul Penggajian — struktur (PLAN/12 F5, skema dokumen 02 §9).
--
-- Yang dibangun di sini adalah KERANGKANYA saja: komponen gaji, struktur gaji
-- berperiode, run, slip, dan jejak perhitungan. Aturan PPh21 dan BPJS TIDAK ada
-- di migrasi ini dan tidak boleh ditambahkan tanpa Gerbang C (dokumen 12 §F5):
-- ahli payroll terikat, 30 slip nyata sebagai kasus uji, dan spike S1 lulus.
--
-- Dua tabel di bawah ini yang paling menentukan apakah modul ini layak dipakai:
--
--   `statutory_configs` — tarif pajak dan BPJS sebagai DATA berversi tanggal,
--   bukan konstanta di dalam kode. Tarif berubah lewat peraturan menteri yang
--   terbit bulan Desember dan berlaku Januari; sistem yang menaruhnya di kode
--   menuntut deploy pada minggu tersibuk dalam setahun, dan tidak dapat
--   menghitung ulang slip bulan lalu dengan tarif yang berlaku saat itu.
--
--   `calculation_traces` — rincian setiap angka pada setiap baris slip. Saat
--   karyawan menyanggah gajinya, HR menunjukkan rinciannya alih-alih berdebat.
--   Tanpa ini, satu-satunya jawaban atas "kenapa potongan saya segini" adalah
--   "begitu hasil sistemnya".

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
-- Komponen gaji
-- -----------------------------------------------------------------------------
CREATE TABLE payroll.components (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" payroll."ComponentType" NOT NULL,
    "calc_method" payroll."CalcMethod" NOT NULL,

    -- Diisi sesuai `calc_method`: FIXED memakai amount, FORMULA memakai
    -- expression, PERCENTAGE memakai rate atas `base_component_code`.
    "amount" DECIMAL(18,2),
    "expression" TEXT,
    "rate" DECIMAL(9,6),
    "base_component_code" TEXT,

    -- Termasuk dasar perhitungan pajak dan BPJS. Dipisah karena tidak semua
    -- tunjangan masuk keduanya, dan salah satu saja sudah mengubah gaji bersih.
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "bpjs_base" BOOLEAN NOT NULL DEFAULT false,

    -- Urutan hitung. Komponen yang memakai hasil komponen lain harus berada
    -- setelahnya; siklus ditolak aplikasi sebelum run dimulai.
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "components_tenant_id_code_key" ON payroll.components("tenant_id", "code");
CREATE INDEX "components_tenant_id_sort_order_idx" ON payroll.components("tenant_id", "sort_order");

-- Setiap metode menuntut kolomnya sendiri terisi.
--
-- Tanpa ini, komponen FORMULA tanpa expression akan menghasilkan nol pada
-- setiap slip — angka yang terlihat seperti keputusan, bukan seperti
-- konfigurasi yang belum selesai.
ALTER TABLE payroll.components
  ADD CONSTRAINT "components_method_complete" CHECK (
    ("calc_method" = 'FIXED' AND "amount" IS NOT NULL) OR
    ("calc_method" = 'FORMULA' AND "expression" IS NOT NULL) OR
    ("calc_method" = 'PERCENTAGE' AND "rate" IS NOT NULL AND "base_component_code" IS NOT NULL) OR
    ("calc_method" IN ('PER_DAY', 'PER_HOUR') AND "amount" IS NOT NULL)
  );

-- -----------------------------------------------------------------------------
-- Struktur gaji per karyawan, berperiode (P13)
-- -----------------------------------------------------------------------------
--
-- Baris ditutup, tidak ditimpa. Kenaikan gaji bulan Juli tidak boleh mengubah
-- slip bulan Juni — dan slip Juni harus tetap dapat dihitung ulang dengan angka
-- yang berlaku saat itu, misalnya ketika ada koreksi presensi.
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

-- Paling banyak satu baris BERJALAN per karyawan per komponen.
--
-- Indeks unik parsial, bukan pemeriksaan aplikasi: dua permintaan kenaikan gaji
-- yang tiba bersamaan akan sama-sama membaca "belum ada yang berjalan".
CREATE UNIQUE INDEX "salary_structures_one_open_per_component"
  ON payroll.salary_structures("tenant_id", "employee_id", "component_id")
  WHERE "effective_to" IS NULL;

ALTER TABLE payroll.salary_structures
  ADD CONSTRAINT "salary_structures_period_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- -----------------------------------------------------------------------------
-- Konfigurasi statutori berversi
-- -----------------------------------------------------------------------------
--
-- Tarif PPh21, PTKP, batas upah BPJS, dan persentase iurannya disimpan sebagai
-- DATA dengan rentang berlaku — bukan konstanta di dalam kode.
--
-- Dua akibat yang membuat perbedaannya nyata:
--
--   1. Perubahan tarif diterapkan lewat konfigurasi, tanpa deploy (DoD F5).
--   2. Slip bulan lalu dapat dihitung ulang dengan tarif yang berlaku BULAN
--      LALU. Tarif di dalam kode hanya mengenal "sekarang", sehingga koreksi
--      presensi Desember yang dihitung ulang pada Januari akan memakai tarif
--      baru dan menghasilkan angka yang tidak pernah ada di slip mana pun.
--
-- ISI tabel ini sengaja KOSONG pada migrasi ini. Mengisinya menuntut Gerbang C.
CREATE TABLE payroll.statutory_configs (
    "id" UUID NOT NULL,
    -- NULL berarti berlaku untuk seluruh tenant (nilai bawaan platform).
    -- Tenant yang punya kekhususan mengisinya dengan tenant_id-nya sendiri.
    "tenant_id" UUID,
    -- PPH21_TER, PTKP, BPJS_KES, BPJS_JHT, BPJS_JP, BPJS_JKK, BPJS_JKM, UMR
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    -- Rujukan peraturan yang menjadi dasarnya. Wajib: angka pajak tanpa dasar
    -- hukum tidak dapat dipertanggungjawabkan saat diperiksa.
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
-- Run penggajian
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

-- Satu run per tenant per periode per jenis, kecuali yang dibatalkan.
--
-- Inilah yang memenuhi DoD "menjalankan run yang sama dua kali menghasilkan
-- tepat satu run". Ditegakkan basis data, bukan pemeriksaan aplikasi: dua klik
-- tombol "Hitung" yang tiba bersamaan akan sama-sama membaca "belum ada run".
CREATE UNIQUE INDEX "payroll_runs_one_active_per_period"
  ON payroll.payroll_runs("tenant_id", "period_year", "period_month", "run_type")
  WHERE "status" <> 'CANCELLED';

ALTER TABLE payroll.payroll_runs
  ADD CONSTRAINT "payroll_runs_month_valid"
  CHECK ("period_month" BETWEEN 1 AND 12);

-- -----------------------------------------------------------------------------
-- Slip gaji dan barisnya
-- -----------------------------------------------------------------------------
CREATE TABLE payroll.payslips (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    "gross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,2) NOT NULL DEFAULT 0,

    -- Potret data hulu pada saat dihitung: hari kerja, hari hadir, jam lembur,
    -- hari cuti tanpa gaji. Disimpan supaya perhitungan ulang dari potret yang
    -- sama memberi hasil identik meski presensinya berubah kemudian.
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

-- Nama dan kode komponen DIDENORMALISASI ke baris slip.
--
-- Slip gaji adalah dokumen yang berlaku bertahun-tahun. Mengganti nama komponen
-- dari "Tunjangan Transport" menjadi "Tunjangan Transportasi" tidak boleh
-- mengubah slip yang sudah diterbitkan — orang yang mencetaknya tahun lalu
-- harus melihat kata yang sama.

-- -----------------------------------------------------------------------------
-- Jejak perhitungan
-- -----------------------------------------------------------------------------
--
-- Satu baris per angka yang dihitung, memuat formula dan nilai variabelnya.
-- Saat karyawan menyanggah gajinya, HR menunjukkan rinciannya alih-alih
-- berdebat — dan itu perbedaan antara sengketa yang selesai dalam lima menit
-- dan sengketa yang berakhir di dinas ketenagakerjaan.
CREATE TABLE payroll.calculation_traces (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "component_code" TEXT NOT NULL,

    -- Formula atau metode yang dipakai, apa adanya.
    "expression" TEXT,
    -- Nilai setiap variabel pada saat dihitung.
    "inputs" JSONB NOT NULL,
    "result" DECIMAL(18,2) NOT NULL,
    -- Penjelasan satu kalimat untuk ditampilkan ke karyawan.
    "explanation" TEXT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calculation_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "calculation_traces_payslip_id_idx"
  ON payroll.calculation_traces("payslip_id");

-- -----------------------------------------------------------------------------
-- Kunci asing
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
-- Hak akses dan RLS
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

-- `statutory_configs` berbeda: barisnya boleh milik platform (tenant_id NULL)
-- dan dibaca seluruh tenant. Kebijakannya karenanya mengizinkan baris global
-- DIBACA siapa pun, tetapi hanya baris tenant sendiri yang dapat DITULIS.
--
-- Tanpa pemisahan itu, satu tenant dapat mengubah tarif PPh21 yang dipakai
-- seluruh tenant lain.
ALTER TABLE payroll.statutory_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.statutory_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payroll.statutory_configs;
CREATE POLICY tenant_isolation ON payroll.statutory_configs
  USING (tenant_id IS NULL OR tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());
