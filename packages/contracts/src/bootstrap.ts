import { z } from 'zod';

/**
 * Bentuk balasan `/api/me/bootstrap` (PLAN/01 §5.4).
 *
 * Ini satu-satunya sumber yang dipakai frontend untuk merender sidebar dan
 * menjaga rute. Perlu ditegaskan apa yang **bukan** perannya: ia bukan otorisasi.
 * Menu yang tidak dirender hanyalah kenyamanan; gateway memeriksa permission
 * yang sama secara mandiri pada setiap request. Bila keduanya berbeda, gateway
 * yang benar (P9).
 */

export const menuNodeSchema: z.ZodType<MenuNode> = z.lazy(() =>
  z.object({
    code: z.string(),
    label: z.string(),
    path: z.string().nullable(),
    icon: z.string().nullable(),
    moduleCode: z.string(),
    children: z.array(menuNodeSchema),
  }),
);

export interface MenuNode {
  code: string;
  label: string;
  path: string | null;
  icon: string | null;
  moduleCode: string;
  children: MenuNode[];
}

export const bootstrapResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    fullName: z.string(),
  }),
  tenant: z.object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CHURNED']),
    planCode: z.string(),
    trialEndsAt: z.string().nullable(),
  }),
  /** Modul yang benar-benar aktif. Dasar penegakan entitlement. */
  modules: z.array(z.string()),
  /**
   * Permission efektif — sudah melalui seluruh presedensi: peran, GRANT, DENY,
   * kedaluwarsa, lalu disaring langganan.
   */
  permissions: z.array(z.string()),
  menu: z.array(menuNodeSchema),
  /**
   * Versi akses. Frontend menyertakannya pada request; bila server melihat versi
   * lebih baru, klien diminta memuat ulang bootstrap. Pencabutan akses berlaku
   * seketika, bukan setelah TTL cache habis.
   */
  accessVersion: z.number().int().nonnegative(),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
