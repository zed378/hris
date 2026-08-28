import { type TenantClient } from '@hrms/db';
import { inviteUser, IamError, type ActorContext } from './administration.ts';

/**
 * Mengundang karyawan menjadi pengguna, secara massal.
 *
 * Ditemukan lewat penelusuran alur pilot, dan bukan oleh satu pun uji.
 *
 * Pemetaan pengguna → karyawan di sistem ini adalah **referensi lunak lewat
 * email** (PLAN/01 §4.2): modul presensi mencari `employee.email` yang sama
 * dengan email pengguna yang sedang masuk. Rancangan itu benar dan disengaja —
 * ia yang membuat modul presensi tidak memegang kunci asing ke tabel karyawan,
 * sehingga keduanya dapat dipisah kelak.
 *
 * Yang tidak ada adalah jembatannya. HR mengimpor 100 karyawan, dan **tidak satu
 * pun dari mereka punya akun.** Mereka tidak dapat masuk, tidak dapat mengetuk
 * presensi, tidak dapat mengajukan cuti, dan tidak dapat melihat slip gajinya.
 * Satu-satunya jalan adalah mengundang mereka satu per satu lewat formulir yang
 * meminta email dan nama yang sudah ada di baris karyawannya.
 *
 * Untuk 100 orang itu 100 kali pengisian formulir dengan data yang sudah dimiliki
 * sistem — dan itu persis yang harus dilakukan tiga pilot Gerbang A setelah
 * berhasil mengimpor karyawannya.
 *
 * ## Yang dilaporkan, bukan didiamkan
 *
 * **Karyawan tanpa email tidak dapat diundang**, dan jumlahnya dikembalikan.
 * Email adalah satu-satunya jembatan ke akun; tanpa itu tidak ada yang dapat
 * dikirimi undangan, dan tidak ada yang akan cocok saat ia mengetuk presensi.
 * Yang perlu dilakukan HR — melengkapi kolom email — hanya dapat dilakukannya
 * bila ia tahu berapa banyak yang kosong.
 *
 * **Yang sudah punya akun dilewati**, bukan digagalkan. Undangan massal yang
 * berhenti pada orang pertama yang sudah terdaftar tidak akan pernah selesai di
 * perusahaan yang menambah karyawan setiap bulan.
 */

export interface BulkInviteInput {
  /** Kosong berarti seluruh karyawan aktif yang belum punya akun. */
  employeeIds?: readonly string[] | undefined;
  roleCode: string;
}

export interface BulkInviteResult {
  invited: Array<{ employeeId: string; userId: string; email: string }>;
  /** Sudah punya akun dengan email yang sama. */
  alreadyHasAccount: number;
  /** Tidak punya email — tidak dapat diundang, dan tidak akan cocok saat presensi. */
  withoutEmail: Array<{ employeeId: string; employeeNumber: string; fullName: string }>;
  failed: Array<{ employeeId: string; reason: string }>;
}

/** Batas satu panggilan. Perusahaan yang lebih besar mengundang per departemen. */
const MAX_PER_CALL = 500;

export async function inviteEmployeesAsUsers(
  tx: TenantClient,
  tenantId: string,
  input: BulkInviteInput,
  ctx: ActorContext,
): Promise<BulkInviteResult> {
  const role = await tx.role.findUnique({
    where: { tenantId_code: { tenantId, code: input.roleCode } },
    select: { id: true },
  });
  if (!role) throw new IamError(`Peran "${input.roleCode}" tidak ditemukan`, 'not_found');

  const employees = await tx.employee.findMany({
    where: {
      tenantId,
      status: { in: ['ACTIVE', 'PROBATION'] },
      ...(input.employeeIds && input.employeeIds.length > 0
        ? { id: { in: [...input.employeeIds] } }
        : {}),
    },
    orderBy: { employeeNumber: 'asc' },
    take: MAX_PER_CALL,
    select: { id: true, employeeNumber: true, fullName: true, email: true },
  });

  const result: BulkInviteResult = {
    invited: [],
    alreadyHasAccount: 0,
    withoutEmail: [],
    failed: [],
  };

  // Akun yang sudah ada dibaca sekali, bukan sekali per karyawan. 500 karyawan
  // berarti 500 query bila diperiksa satu per satu — seluruhnya di dalam satu
  // transaksi permintaan yang dibatasi lima belas detik.
  const emails = employees
    .map((employee) => employee.email?.trim().toLowerCase())
    .filter((email): email is string => !!email);

  const existing = await tx.user.findMany({
    where: { tenantId, email: { in: emails } },
    select: { email: true },
  });
  const taken = new Set(existing.map((user) => user.email.toLowerCase()));

  for (const employee of employees) {
    const email = employee.email?.trim().toLowerCase();

    if (!email) {
      result.withoutEmail.push({
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        fullName: employee.fullName,
      });
      continue;
    }

    if (taken.has(email)) {
      result.alreadyHasAccount += 1;
      continue;
    }

    try {
      const { userId } = await inviteUser(
        tx,
        tenantId,
        { email, fullName: employee.fullName, roleCode: input.roleCode },
        ctx,
      );
      result.invited.push({ employeeId: employee.id, userId, email });
      // Ditandai supaya dua baris karyawan dengan email yang sama — hal yang
      // terjadi pada suami-istri yang berbagi alamat — tidak menghasilkan
      // undangan kedua yang pasti gagal.
      taken.add(email);
    } catch (error) {
      result.failed.push({
        employeeId: employee.id,
        reason: error instanceof Error ? error.message : 'Undangan gagal',
      });
    }
  }

  return result;
}
