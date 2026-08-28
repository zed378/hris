import { writeAudit, type TenantClient } from '@hrms/db';
import { revealPii } from '../employee/index.ts';

/**
 * Ekspor seluruh data tenant (PLAN/12 F6 DoD, UU PDP No. 27/2022).
 *
 * Bukan fitur kenyamanan. UU PDP menjamin hak portabilitas data: subjek data —
 * dan dalam konteks ini perusahaan yang mewakili karyawannya — berhak menerima
 * datanya dalam format yang dapat dibaca mesin dan dipindahkan ke sistem lain.
 *
 * Yang menentukan apakah ekspor ini memenuhi haknya atau hanya terlihat
 * memenuhi:
 *
 * **Lengkap, bukan sebagian — termasuk modul yang TIDAK sedang dilanggan.**
 *
 * Versi pertama hanya mengekspor modul aktif, dan itu salah persis pada kasus
 * yang paling penting: pelanggan yang menurunkan paketnya lalu ingin pindah
 * sistem tidak akan menerima data penggajiannya. Datanya masih ada — modul yang
 * nonaktif tidak menghapus apa pun — tetapi ia tidak dapat mengambilnya.
 *
 * Itu penguncian yang dibungkus kepatuhan, dan bertentangan dengan hak yang
 * hendak dipenuhi ekspor ini. Portabilitas data adalah hak menurut undang-undang;
 * ia tidak bergantung pada apa yang sedang dibayar seseorang bulan ini.
 *
 * Daftar tabelnya ditulis eksplisit supaya modul baru yang lupa ditambahkan
 * terlihat sebagai kolom yang hilang di berkasnya, bukan diam-diam tidak ikut.
 *
 * **PII dalam bentuk aslinya, dan itu keputusan sadar.** Ekspor tersamar tidak
 * dapat dipakai memindahkan data — NIK "3201********9012" tidak berguna bagi
 * sistem mana pun. Karena itu endpoint yang memanggilnya menuntut izin
 * `employee.pii.unmask`, dan setiap pemanggilan diaudit.
 *
 * **Format JSON, bukan Excel.** Portabilitas menuntut format yang dapat dibaca
 * mesin lain; Excel dengan sel bergabung dan format tanggal lokal bukan itu.
 * Ekspor Excel per modul tetap ada untuk keperluan sehari-hari.
 */

export interface TenantExport {
  meta: {
    tenantCode: string;
    tenantName: string;
    exportedAt: string;
    /** Versi bentuk berkas. Dinaikkan bila strukturnya berubah tak kompatibel. */
    formatVersion: 1;
    /** Modul yang datanya disertakan. */
    modules: string[];
  };
  employees: unknown[];
  departments: unknown[];
  positions: unknown[];
  employments: unknown[];
  contracts: unknown[];
  documents: unknown[];
  workSites: unknown[];
  shifts: unknown[];
  schedules: unknown[];
  holidays: unknown[];
  punchLogs: unknown[];
  attendanceDays: unknown[];
  attendancePeriods: unknown[];
  attendanceConsents: unknown[];
  leaveTypes: unknown[];
  leaveBalances: unknown[];
  leaveRequests: unknown[];
  balanceLedger: unknown[];
  payrollComponents: unknown[];
  salaryStructures: unknown[];
  payrollRuns: unknown[];
  payslips: unknown[];
  payslipLines: unknown[];
  users: unknown[];
  roles: unknown[];
}

/**
 * Batas baris per tabel.
 *
 * Ekspor yang menghabiskan memori proses akan menjatuhkan aplikasi untuk
 * seluruh tenant, dan itu harga yang terlalu mahal untuk satu permintaan
 * portabilitas. Bila sebuah tenant melewati batas ini, ekspor per rentang
 * tanggal adalah jawabannya — dan pemotongan DINYATAKAN di berkasnya, bukan
 * dilakukan diam-diam.
 */
const MAX_ROWS_PER_TABLE = 100_000;

export interface ExportOptions {
  /** Menyertakan PII dalam bentuk asli. Menuntut izin unmask di pemanggil. */
  includePii: boolean;
  /**
   * Modul yang sedang aktif. Dicatat pada `meta`, TIDAK dipakai menyaring isi.
   *
   * Lihat penjelasan di kepala berkas: data modul yang nonaktif tetap ikut,
   * karena portabilitas tidak bergantung pada langganan yang sedang berjalan.
   */
  modules: ReadonlySet<string>;
}

/**
 * Membuat seluruh nilai dapat diserialkan ke JSON.
 *
 * `BigInt` tidak punya representasi JSON — `JSON.stringify` melemparnya dengan
 * "Do not know how to serialize a BigInt", dan galat itu menjatuhkan SELURUH
 * ekspor, bukan satu kolomnya.
 *
 * Yang memakainya adalah kunci pada tabel bervolume tinggi: buku besar saldo
 * cuti dan jejak akses. Keduanya justru yang paling perlu ikut terbawa saat
 * pelanggan pindah sistem — buku besar adalah satu-satunya penjelasan mengapa
 * saldo cuti seseorang bernilai sekian.
 *
 * Diubah menjadi string, bukan number: id `BIGSERIAL` dapat melewati
 * `Number.MAX_SAFE_INTEGER`, dan angka yang dibulatkan diam-diam pada ekspor
 * portabilitas akan menghasilkan dua baris berbeda dengan id yang sama di
 * sistem tujuan.
 */
function serializable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    // Prisma.Decimal punya `toJSON`-nya sendiri dan tidak boleh dibongkar
    // menjadi properti internalnya.
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializable(item),
      ]),
    );
  }
  return value;
}

export async function exportTenantData(
  tx: TenantClient,
  tenantId: string,
  options: ExportOptions,
  actorUserId: string,
): Promise<TenantExport & { truncated: string[] }> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { code: true, name: true },
  });

  const take = MAX_ROWS_PER_TABLE;
  const truncated: string[] = [];

  /** Menjalankan query dan mencatat bila hasilnya terpotong batas. */
  const collect = async <T>(name: string, run: () => Promise<T[]>): Promise<T[]> => {
    const rows = await run();
    if (rows.length >= take) truncated.push(name);
    return rows;
  };

  const [
    employees,
    departments,
    positions,
    employments,
    contracts,
    documents,
    workSites,
    shifts,
    schedules,
    holidays,
    punchLogs,
    attendanceDays,
    attendancePeriods,
    attendanceConsents,
    leaveTypes,
    leaveBalances,
    leaveRequests,
    balanceLedger,
    payrollComponents,
    salaryStructures,
    payrollRuns,
    payslips,
    payslipLines,
    users,
    roles,
  ] = await Promise.all([
    collect('employees', () => tx.employee.findMany({ where: { tenantId }, take })),
    collect('departments', () => tx.department.findMany({ where: { tenantId }, take })),
    collect('positions', () => tx.position.findMany({ where: { tenantId }, take })),
    collect('employments', () => tx.employment.findMany({ where: { tenantId }, take })),
    collect('contracts', () => tx.employeeContract.findMany({ where: { tenantId }, take })),
    collect('documents', () =>
          tx.employeeDocument.findMany({
            where: { tenantId },
            take,
            // `storageKey` DIBUANG. Berkas fisiknya tidak ikut dalam JSON, dan
            // kunci penyimpanan tanpa berkasnya hanya membocorkan pola nama
            // objek tanpa memberi manfaat apa pun kepada penerimanya.
            select: {
              id: true,
              employeeId: true,
              kind: true,
              title: true,
              fileName: true,
              mimeType: true,
              sizeBytes: true,
              expiresAt: true,
              createdAt: true,
              archivedAt: true,
            },
          }),
        ),

    collect('workSites', () => tx.workSite.findMany({ where: { tenantId }, take })),
    collect('shifts', () => tx.shift.findMany({ where: { tenantId }, take })),
    collect('schedules', () => tx.schedule.findMany({ where: { tenantId }, take })),
    collect('holidays', () => tx.holiday.findMany({ where: { tenantId }, take })),
    collect('punchLogs', () =>
          tx.punchLog.findMany({
            where: { tenantId },
            take,
            orderBy: { punchedAt: 'desc' },
          }),
        ),
    collect('attendanceDays', () => tx.attendanceDay.findMany({ where: { tenantId }, take })),
    collect('attendancePeriods', () =>
          tx.attendancePeriod.findMany({ where: { tenantId }, take }),
        ),
    collect('attendanceConsents', () =>
          tx.attendanceConsent.findMany({ where: { tenantId }, take }),
        ),

    collect('leaveTypes', () => tx.leaveType.findMany({ where: { tenantId }, take })),
    collect('leaveBalances', () => tx.leaveBalance.findMany({ where: { tenantId }, take })),
    collect('leaveRequests', () => tx.leaveRequest.findMany({ where: { tenantId }, take })),
    collect('balanceLedger', () => tx.balanceLedger.findMany({ where: { tenantId }, take })),

    collect('payrollComponents', () =>
          tx.payrollComponent.findMany({ where: { tenantId }, take }),
        ),
    collect('salaryStructures', () =>
          tx.salaryStructure.findMany({ where: { tenantId }, take }),
        ),
    collect('payrollRuns', () => tx.payrollRun.findMany({ where: { tenantId }, take })),
    collect('payslips', () => tx.payslip.findMany({ where: { tenantId }, take })),
    collect('payslipLines', () => tx.payslipLine.findMany({ where: { tenantId }, take })),

    // Pengguna dan peran selalu disertakan: tanpa keduanya, data karyawan tidak
    // dapat dihubungkan kembali ke siapa yang boleh melihatnya di sistem tujuan.
    collect('users', () =>
      tx.user.findMany({
        where: { tenantId },
        take,
        // Hash kata sandi TIDAK diekspor. Ia tidak berguna di sistem lain, dan
        // berkas ekspor yang memuatnya menjadi target yang jauh lebih berharga.
        select: {
          id: true,
          email: true,
          fullName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ),
    collect('roles', () => tx.role.findMany({ where: { tenantId }, take })),
  ]);

  /**
   * PII dibuka atau tetap tersamar sesuai izin pemanggil.
   *
   * `revealPii` membaca kolom tersamar yang sudah tersimpan ketika tidak
   * berizin — ia tidak pernah menyentuh kunci enkripsi pada jalur itu.
   */
  const employeesOut = (employees as Array<Record<string, unknown>>).map((row) => {
    const rest: Record<string, unknown> = { ...row };
    // Ciphertext dibuang dari keluaran. Ia tidak dapat dibaca sistem lain, dan
    // berkas ekspor yang memuatnya menjadi target yang jauh lebih berharga
    // tanpa memberi manfaat apa pun kepada penerimanya.
    for (const column of [
      'nationalIdEncrypted',
      'nationalIdIndex',
      'taxIdEncrypted',
      'taxIdIndex',
      'bankAccountEncrypted',
    ]) {
      delete rest[column];
    }
    return { ...rest, pii: revealPii(row as never, options.includePii) };
  });

  await writeAudit(tx, tenantId, {
    action: 'tenant.data.exported',
    entityType: 'tenant',
    entityId: tenantId,
    actorUserId,
    after: {
      includePii: options.includePii,
      employeeCount: employees.length,
      punchCount: punchLogs.length,
      truncated,
    },
  });

  const payload = {
    meta: {
      tenantCode: tenant?.code ?? '',
      tenantName: tenant?.name ?? '',
      exportedAt: new Date().toISOString(),
      formatVersion: 1,
      modules: [...options.modules].sort(),
    },
    employees: employeesOut,
    departments,
    positions,
    employments,
    contracts,
    documents,
    workSites,
    shifts,
    schedules,
    holidays,
    punchLogs,
    attendanceDays,
    attendancePeriods,
    attendanceConsents,
    leaveTypes,
    leaveBalances,
    leaveRequests,
    balanceLedger,
    payrollComponents,
    salaryStructures,
    payrollRuns,
    payslips,
    payslipLines,
    users,
    roles,
    truncated,
  };

  return serializable(payload) as TenantExport & { truncated: string[] };
}
