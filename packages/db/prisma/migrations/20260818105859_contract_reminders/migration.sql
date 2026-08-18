-- CreateEnum
CREATE TYPE "employee"."ReminderThreshold" AS ENUM ('D90', 'D30', 'D7', 'EXPIRED');

-- CreateTable
CREATE TABLE "employee"."contract_reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "threshold" "employee"."ReminderThreshold" NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_reminders_tenant_id_sent_at_idx" ON "employee"."contract_reminders"("tenant_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "contract_reminders_contract_id_threshold_key" ON "employee"."contract_reminders"("contract_id", "threshold");

-- AddForeignKey
ALTER TABLE "employee"."contract_reminders" ADD CONSTRAINT "contract_reminders_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "employee"."employee_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- RLS untuk pengingat kontrak
-- =============================================================================

ALTER TABLE employee.contract_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.contract_reminders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.contract_reminders;
CREATE POLICY tenant_isolation ON employee.contract_reminders
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());


-- -----------------------------------------------------------------------------
-- Daftar tenant aktif untuk job terjadwal
--
-- Pemindaian kontrak berjalan setiap hari dan bersifat lintas tenant menurut
-- sifatnya — ia harus memeriksa semua orang. Tetapi "lintas tenant" tidak boleh
-- berarti "membaca data semua orang sekaligus".
--
-- Fungsi ini mengembalikan DAFTAR UUID, dan hanya itu. Tidak ada nama, tidak ada
-- kode, tidak ada paket. Worker kemudian mengulang `withTenant(id)` untuk setiap
-- baris, sehingga seluruh pembacaan kontrak tetap terjadi di bawah RLS penuh.
--
-- Permukaan lintas-tenant yang sesungguhnya karenanya hanya berupa "ada berapa
-- tenant dan apa id-nya" — informasi yang sudah dimiliki control plane, dan yang
-- tidak memberi tahu apa pun tentang isi data siapa pun.
--
-- Ini pengecualian SECURITY DEFINER kelima. Uji `rls-coverage` sengaja gagal saat
-- jumlahnya berubah, supaya penambahan seperti ini selalu dijelaskan di PR.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.active_tenant_ids()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT t.id FROM tenant.tenants t WHERE t.status IN ('TRIAL', 'ACTIVE')
$$;

COMMENT ON FUNCTION public.active_tenant_ids() IS
  'Job terjadwal: daftar id tenant aktif. Mengembalikan UUID saja. Jangan tambahkan kolom apa pun di sini.';

REVOKE ALL ON FUNCTION public.active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.active_tenant_ids() TO hrms_worker;
