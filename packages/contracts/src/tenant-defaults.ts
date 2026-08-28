/**
 * Konfigurasi bawaan untuk tenant yang baru dibuat.
 *
 * Ditemukan lewat penelusuran alur pilot dari nol — daftar, undang, konfigurasi,
 * impor, presensi, cuti, payroll — dan bukan oleh satu pun uji.
 *
 * `provisionTenant` membuat tenant, modul, peran, dan pemilik. Yang tidak
 * dibuatnya: **jenis cuti dan komponen gaji.** Keduanya hanya ada pada tenant
 * demo, lewat seed yang tidak pernah berjalan untuk pelanggan sungguhan.
 *
 * Akibatnya, sekali lagi, tanpa satu pun galat:
 *
 *   - Modul cuti aktif, menunya tampil, dan daftar jenis cutinya **kosong**.
 *     Tidak ada seorang pun yang dapat mengajukan cuti, dan yang terlihat hanya
 *     dropdown tanpa pilihan.
 *   - Modul payroll aktif, dan tanpa satu pun komponen **setiap slip gaji
 *     bernilai nol rupiah** — dihitung dengan benar, dari ketiadaan.
 *
 * Ini memblokir Gerbang A: pilot yang melakukan onboarding mandiri berhenti di
 * layar cuti pada hari pertama.
 *
 * ## Mengapa nilainya nol
 *
 * Seluruh `amount` komponen gaji sengaja **0**. Angka gaji adalah keputusan
 * perusahaan, dan menebaknya berarti seseorang menjalankan payroll pertamanya di
 * atas angka yang tidak pernah ia setujui. Yang disediakan di sini adalah
 * *bentuknya* — komponen mana yang ada, mana yang kena pajak, mana yang menjadi
 * dasar BPJS — bukan besarannya.
 *
 * Jenis cuti sebaliknya membawa angka, karena angkanya berasal dari undang-undang
 * dan bukan dari kebijakan: 12 hari cuti tahunan setelah 12 bulan bekerja
 * (UU Ketenagakerjaan Pasal 79), 3 hari menikah, 2 hari kematian keluarga inti
 * (Pasal 93). Tenant tetap dapat mengubahnya; yang bawaan adalah yang menurut
 * hukum berlaku bila tidak ada perjanjian yang lebih baik.
 */

export interface DefaultLeaveType {
  code: string;
  name: string;
  defaultQuotaDays: number;
  minServiceMonths: number;
  maxCarryOverDays?: number;
  accrualMethod?: 'ANNUAL_GRANT' | 'MONTHLY_ACCRUAL' | 'ANNIVERSARY' | 'UNLIMITED' | 'NONE';
  deductFromBalance?: boolean;
  requiresAttachment?: boolean;
  affectsPayroll?: boolean;
  isPaid?: boolean;
  colorHex: string;
}

export const DEFAULT_LEAVE_TYPES: readonly DefaultLeaveType[] = [
  {
    code: 'TAHUNAN',
    name: 'Cuti Tahunan',
    defaultQuotaDays: 12,
    minServiceMonths: 12,
    maxCarryOverDays: 6,
    colorHex: '#3b82f6',
  },
  {
    code: 'SAKIT',
    name: 'Cuti Sakit',
    defaultQuotaDays: 0,
    minServiceMonths: 0,
    accrualMethod: 'UNLIMITED',
    deductFromBalance: false,
    requiresAttachment: true,
    colorHex: '#ef4444',
  },
  {
    code: 'MELAHIRKAN',
    name: 'Cuti Melahirkan',
    defaultQuotaDays: 0,
    minServiceMonths: 0,
    accrualMethod: 'NONE',
    deductFromBalance: false,
    requiresAttachment: true,
    affectsPayroll: true,
    colorHex: '#ec4899',
  },
  {
    code: 'MENIKAH',
    name: 'Cuti Menikah',
    defaultQuotaDays: 3,
    minServiceMonths: 0,
    accrualMethod: 'NONE',
    deductFromBalance: false,
    colorHex: '#a855f7',
  },
  {
    code: 'DUKA',
    name: 'Cuti Kematian Keluarga Inti',
    defaultQuotaDays: 2,
    minServiceMonths: 0,
    accrualMethod: 'NONE',
    deductFromBalance: false,
    colorHex: '#64748b',
  },
  {
    code: 'TANPA_GAJI',
    name: 'Cuti Tanpa Gaji',
    defaultQuotaDays: 0,
    minServiceMonths: 0,
    isPaid: false,
    accrualMethod: 'NONE',
    deductFromBalance: false,
    affectsPayroll: true,
    colorHex: '#f59e0b',
  },
] as const;

export interface DefaultPayrollComponent {
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'INFO';
  calcMethod: 'FIXED' | 'FORMULA' | 'PER_DAY' | 'PER_HOUR' | 'PERCENTAGE';
  amount?: number;
  expression?: string;
  taxable: boolean;
  bpjsBase: boolean;
  sortOrder: number;
}

export const DEFAULT_PAYROLL_COMPONENTS: readonly DefaultPayrollComponent[] = [
  {
    code: 'GAJI_POKOK',
    name: 'Gaji Pokok',
    type: 'EARNING',
    calcMethod: 'FIXED',
    amount: 0,
    taxable: true,
    bpjsBase: true,
    sortOrder: 10,
  },
  {
    code: 'TUNJANGAN_TETAP',
    name: 'Tunjangan Tetap',
    type: 'EARNING',
    calcMethod: 'FIXED',
    amount: 0,
    taxable: true,
    bpjsBase: true,
    sortOrder: 20,
  },
  {
    code: 'TUNJANGAN_HADIR',
    name: 'Tunjangan Kehadiran',
    type: 'EARNING',
    calcMethod: 'PER_DAY',
    amount: 0,
    taxable: true,
    bpjsBase: false,
    sortOrder: 30,
  },
  {
    code: 'LEMBUR',
    name: 'Upah Lembur',
    type: 'EARNING',
    calcMethod: 'PER_HOUR',
    amount: 0,
    taxable: true,
    bpjsBase: false,
    sortOrder: 40,
  },
  {
    /**
     * Prorata alfa: gaji pokok dibagi hari kerja, dikali hari alfa.
     *
     * Ditulis sebagai formula alih-alih kode supaya tenant dapat mengubahnya
     * tanpa deploy — sebagian perusahaan memotong dari gaji pokok saja, sebagian
     * dari pokok ditambah tunjangan tetap.
     *
     * Penjaga `HARI_KERJA > 0` bukan hiasan: bulan yang belum punya satu pun
     * baris presensi menghasilkan pembagian dengan nol, dan `if()` pada parser
     * formula ini mengevaluasi cabangnya secara malas justru karena kasus ini.
     */
    code: 'POTONGAN_ALFA',
    name: 'Potongan Ketidakhadiran',
    type: 'DEDUCTION',
    calcMethod: 'FORMULA',
    expression: 'if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)',
    taxable: false,
    bpjsBase: false,
    sortOrder: 100,
  },
] as const;
