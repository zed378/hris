import { EventTopic } from '@hrms/contracts';
import { Prisma, publishEvent, writeAudit, type TenantClient } from '@hrms/db';
import { attachToRequest, claimAttachment } from './attachments.ts';
import {
  LeaveError,
  ensureBalance,
  lockBalance,
  writeLedger,
  type BalanceView,
} from './balance.ts';

/**
 * Pengajuan dan persetujuan cuti (PLAN/12 F4).
 *
 * Alur saldonya sengaja tiga langkah, bukan dua:
 *
 *   pengajuan  → HOLD    (`pending_days` naik)
 *   persetujuan → CONSUME (`pending_days` turun, `used_days` naik)
 *   penolakan / pembatalan → RELEASE (`pending_days` turun)
 *
 * Langkah HOLD itulah yang mencegah seseorang mengajukan tiga cuti dua hari di
 * atas saldo dua hari lalu menunggu ketiganya disetujui. Tanpa penahanan, setiap
 * pengajuan melihat saldo yang masih utuh karena belum ada satu pun yang
 * memotong — dan kelebihannya baru ketahuan saat persetujuan ketiga ditolak
 * basis data, setelah dua manajer terlanjur menyetujui.
 */

/**
 * Hari libur mingguan seorang karyawan, dibaca dari jadwalnya.
 *
 * Kunci berupa tanggal ISO (`YYYY-MM-DD`); nilai `true` berarti hari itu
 * DIJADWALKAN LIBUR bagi orang ini. Tanggal yang tidak ada kuncinya jatuh ke
 * anggapan Senin–Jumat.
 */
export type DayOffMap = ReadonlyMap<string, boolean>;

/**
 * Berapa hari kerja dalam rentang, mengecualikan libur mingguan dan hari libur.
 *
 * Sabtu dan Minggu hanyalah **anggapan terakhir**, bukan aturan. Anggapan itu
 * salah untuk sebagian besar tenant yang dituju produk ini: pabrik enam hari
 * kerja, ritel yang libur hari Senin, satpam tiga shift yang liburnya berputar.
 * Pada pabrik enam hari, mengajukan cuti Senin–Sabtu terpotong lima hari saldo
 * padahal enam hari kerja ditinggalkan — perusahaan kehilangan satu hari kerja
 * setiap kali, dan tidak ada yang menampakkannya karena angkanya tetap masuk
 * akal.
 *
 * Yang benar ada di `attendance.schedules`: satu baris per karyawan per tanggal,
 * dengan `is_day_off` yang sudah dipakai modul presensi untuk memutuskan status
 * `DAY_OFF`. Cuti kini membaca sumber yang sama, sehingga presensi dan cuti
 * tidak dapat berbeda pendapat tentang hari mana yang hari kerja.
 *
 * Tanggal tanpa baris jadwal jatuh ke Senin–Jumat. Tenant yang belum
 * menjadwalkan apa pun karena itu tidak berubah perilakunya.
 */
export function countWorkingDays(
  start: Date,
  end: Date,
  holidays: ReadonlySet<string>,
  dayOffs: DayOffMap = new Map(),
): number {
  let days = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  while (cursor.getTime() <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    const scheduled = dayOffs.get(iso);
    const weekday = cursor.getUTCDay();

    // Jadwal menang atas anggapan akhir pekan — ke DUA arah. Sabtu yang
    // dijadwalkan masuk terhitung hari kerja; Senin yang dijadwalkan libur
    // tidak. Membuat jadwal hanya dapat mengurangi hari kerja akan salah untuk
    // pabrik enam hari, yang justru menambahnya.
    const isWorkDay = scheduled === undefined ? weekday !== 0 && weekday !== 6 : !scheduled;

    if (isWorkDay && !holidays.has(iso)) days += 1;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

export interface SubmitInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  isHalfDay: boolean;
  reason: string;
  attachmentKey?: string | null | undefined;
  /** Pengguna yang akan memutuskan. Alur berjenjang menyusul bila tenant butuh. */
  approverId: string;
}

export interface RequestView {
  id: string;
  requestNumber: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  isHalfDay: boolean;
  reason: string;
  status: string;
  currentApproverId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

function toView(row: {
  id: string;
  requestNumber: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  totalDays: Prisma.Decimal;
  isHalfDay: boolean;
  reason: string;
  status: string;
  currentApproverId: string | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  leaveType?: { name: string } | undefined;
}): RequestView {
  return {
    id: row.id,
    requestNumber: row.requestNumber,
    employeeId: row.employeeId,
    leaveTypeId: row.leaveTypeId,
    leaveTypeName: row.leaveType?.name ?? '',
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    totalDays: Number(row.totalDays),
    isHalfDay: row.isHalfDay,
    reason: row.reason,
    status: row.status,
    currentApproverId: row.currentApproverId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** Nomor pengajuan yang dapat dibaca manusia: `CUTI-2026-000123`. */
async function nextRequestNumber(tx: TenantClient, tenantId: string, year: number): Promise<string> {
  const count = await tx.leaveRequest.count({
    where: { tenantId, requestNumber: { startsWith: `CUTI-${year}-` } },
  });
  return `CUTI-${year}-${String(count + 1).padStart(6, '0')}`;
}

/**
 * Mengajukan cuti, sekaligus menahan saldonya.
 *
 * Seluruhnya dalam satu transaksi. Penahanan saldo yang terpisah dari pembuatan
 * pengajuan akan meninggalkan salah satunya tanpa yang lain bila proses mati di
 * antaranya — dan keduanya sama buruknya: saldo tertahan tanpa pengajuan tidak
 * dapat dilepaskan siapa pun, pengajuan tanpa penahanan menghapus seluruh
 * gunanya penahanan.
 */
export async function submitRequest(
  tx: TenantClient,
  tenantId: string,
  input: SubmitInput,
  actorUserId: string,
): Promise<RequestView> {
  if (input.endDate < input.startDate) {
    throw new LeaveError('Tanggal selesai mendahului tanggal mulai', 'invalid_state');
  }

  const type = await tx.leaveType.findFirst({
    where: { id: input.leaveTypeId, tenantId, isActive: true },
  });
  if (!type) throw new LeaveError('Jenis cuti tidak ditemukan atau tidak aktif', 'not_found');

  /**
   * Lampiran wajib berarti BERKAS yang benar-benar terunggah.
   *
   * Sebelum ini pemeriksaannya hanya `!input.attachmentKey` atas sebuah kolom
   * teks bebas, dan layarnya menampilkan kotak isian bertuliskan "Nomor atau
   * nama berkas surat dokter". Artinya syarat "wajib melampirkan surat dokter"
   * dipenuhi dengan mengetik kata "ada".
   *
   * Untuk cuti sakit, surat dokter itulah satu-satunya hal yang membedakan cuti
   * berbayar dari mangkir. Syarat yang menerima sembarang teks bukan syarat; ia
   * kotak isian yang membuat semua pihak mengira ada bukti yang tersimpan.
   */
  let attachmentId: string | null = null;

  if (type.requiresAttachment) {
    if (!input.attachmentKey) {
      throw new LeaveError(
        `${type.name} wajib menyertakan lampiran, mis. surat dokter. Unggah berkasnya lebih dulu.`,
        'invalid_state',
      );
    }
    // Melempar bila kuncinya karangan, milik orang lain, atau sudah dipakai
    // pengajuan lain.
    attachmentId = (await claimAttachment(tx, tenantId, input.employeeId, input.attachmentKey)).id;
  } else if (input.attachmentKey) {
    // Lampiran opsional tetap diperiksa kepemilikannya. Jenis cuti yang tidak
    // mewajibkannya bukan alasan untuk menerima kunci milik orang lain.
    attachmentId = (await claimAttachment(tx, tenantId, input.employeeId, input.attachmentKey)).id;
  }

  // Masa kerja minimum. UU Ketenagakerjaan mensyaratkan 12 bulan untuk cuti
  // tahunan, dan tenant dapat menetapkan lebih longgar tetapi tidak lebih ketat
  // lewat `minServiceMonths`.
  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, tenantId },
    select: { joinDate: true },
  });
  if (!employee) throw new LeaveError('Karyawan tidak ditemukan', 'not_found');

  const monthsOfService =
    (input.startDate.getTime() - employee.joinDate.getTime()) / (30.44 * 86_400_000);
  if (monthsOfService < type.minServiceMonths) {
    throw new LeaveError(
      `${type.name} baru dapat diambil setelah ${type.minServiceMonths} bulan masa kerja. ` +
        `Saat tanggal cuti, masa kerja baru ${Math.floor(monthsOfService)} bulan.`,
      'not_entitled',
    );
  }

  const holidays = await tx.holiday.findMany({
    where: { tenantId, date: { gte: input.startDate, lte: input.endDate } },
    select: { date: true },
  });
  const holidaySet = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));

  // Jadwal karyawan ini pada rentang yang diajukan. Hanya baris yang benar-benar
  // ada yang diambil — ketiadaan baris berarti "pakai anggapan Senin–Jumat",
  // bukan "hari libur".
  const schedules = await tx.schedule.findMany({
    where: {
      tenantId,
      employeeId: input.employeeId,
      workDate: { gte: input.startDate, lte: input.endDate },
    },
    select: { workDate: true, isDayOff: true },
  });
  const dayOffs = new Map(
    schedules.map((s) => [s.workDate.toISOString().slice(0, 10), s.isDayOff] as const),
  );

  const workingDays = countWorkingDays(input.startDate, input.endDate, holidaySet, dayOffs);
  if (workingDays === 0) {
    throw new LeaveError(
      'Rentang yang dipilih tidak memuat satu pun hari kerja — seluruhnya akhir pekan atau hari libur.',
      'invalid_state',
    );
  }

  const totalDays = input.isHalfDay ? 0.5 : workingDays;
  const periodYear = input.startDate.getUTCFullYear();

  let balance: BalanceView | null = null;
  if (type.deductFromBalance) {
    balance = await ensureBalance(
      tx,
      tenantId,
      input.employeeId,
      input.leaveTypeId,
      periodYear,
      actorUserId,
    );

    // Validasi SETELAH lock diperoleh. Membacanya sebelum lock berarti
    // memutuskan atas nilai yang mungkin sudah berubah.
    if (balance.availableDays < totalDays) {
      throw new LeaveError(
        `Saldo ${type.name} tidak mencukupi: tersisa ${balance.availableDays} hari, diminta ${totalDays} hari.`,
        'insufficient_balance',
      );
    }
  }

  const requestNumber = await nextRequestNumber(tx, tenantId, periodYear);

  let request;
  try {
    request = await tx.leaveRequest.create({
      data: {
        tenantId,
        requestNumber,
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        isHalfDay: input.isHalfDay,
        totalDays: new Prisma.Decimal(totalDays),
        reason: input.reason.trim(),
        attachmentKey: input.attachmentKey ?? null,
        status: 'PENDING',
        currentApproverId: input.approverId,
        submittedAt: new Date(),
      },
      include: { leaveType: { select: { name: true } } },
    });
  } catch (error) {
    // Constraint EXCLUDE menolak tumpang tindih. Pesannya diterjemahkan di sini
    // karena galat basis data mentah tidak dapat dibaca penggunanya, dan karena
    // inilah satu-satunya tempat yang tahu bahwa yang dimaksud adalah cuti.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      String(error).includes('excl_leave_overlap')
    ) {
      throw new LeaveError(
        'Sudah ada pengajuan cuti Anda yang mencakup salah satu tanggal ini.',
        'overlap',
      );
    }
    throw error;
  }

  await tx.leaveApproval.create({
    data: {
      tenantId,
      requestId: request.id,
      stepOrder: 1,
      approverId: input.approverId,
    },
  });

  if (balance) {
    await tx.leaveBalance.update({
      where: { id: balance.id },
      data: {
        pendingDays: { increment: new Prisma.Decimal(totalDays) },
        version: { increment: 1 },
      },
    });

    await writeLedger(tx, tenantId, {
      balanceId: balance.id,
      entryType: 'HOLD',
      days: -totalDays,
      referenceType: 'leave_request',
      referenceId: request.id,
      note: `Ditahan untuk ${requestNumber}`,
      actorUserId,
    });
  }

  // Diadopsi setelah pengajuannya ada — pengunggahnya belum tahu id-nya saat
  // mengunggah, sehingga lampiran selalu lahir yatim.
  if (attachmentId) await attachToRequest(tx, tenantId, attachmentId, request.id);

  await publishEvent(tx, tenantId, {
    topic: EventTopic.LEAVE_REQUEST_SUBMITTED,
    payload: {
      requestId: request.id,
      requestNumber,
      employeeId: input.employeeId,
      approverId: input.approverId,
      totalDays,
    },
  });

  return toView(request);
}

export interface DecisionInput {
  requestId: string;
  approve: boolean;
  comment: string;
}

/**
 * Memutuskan pengajuan cuti.
 *
 * Baris saldo dikunci SEBELUM status pengajuan diperiksa, dan urutan itu
 * disengaja. Lima puluh persetujuan simultan atas pengajuan yang sama akan
 * mengantre di lock saldo; yang pertama mengubah status menjadi APPROVED, dan
 * empat puluh sembilan sisanya membaca status itu setelah lock dilepas — lalu
 * berhenti karena statusnya bukan PENDING lagi.
 *
 * Mengunci setelah memeriksa status akan membalik urutannya: lima puluh
 * transaksi sama-sama membaca PENDING, lalu antre menulis.
 */
export async function decideRequest(
  tx: TenantClient,
  tenantId: string,
  decision: DecisionInput,
  actorUserId: string,
): Promise<RequestView> {
  const request = await tx.leaveRequest.findFirst({
    where: { id: decision.requestId, tenantId },
    include: { leaveType: { select: { name: true, deductFromBalance: true } } },
  });
  if (!request) throw new LeaveError('Pengajuan tidak ditemukan', 'not_found');

  const periodYear = request.startDate.getUTCFullYear();
  const balance = request.leaveType.deductFromBalance
    ? await lockBalance(tx, tenantId, request.employeeId, request.leaveTypeId, periodYear)
    : null;

  // Dibaca ULANG setelah lock. Nilai di `request` di atas berasal dari sebelum
  // lock diperoleh, dan pada 50 permintaan simultan ia hampir pasti basi.
  const fresh = await tx.leaveRequest.findFirst({
    where: { id: decision.requestId, tenantId },
    select: { status: true },
  });
  if (fresh?.status !== 'PENDING') {
    throw new LeaveError(
      `Pengajuan ini sudah ${fresh?.status === 'APPROVED' ? 'disetujui' : 'diputuskan'} sebelumnya.`,
      'invalid_state',
    );
  }

  const totalDays = Number(request.totalDays);
  const now = new Date();

  if (balance) {
    if (decision.approve) {
      // Penahanan menjadi pemakaian. Saldo tersedia tidak berubah pada langkah
      // ini — ia sudah berkurang saat pengajuan.
      await tx.leaveBalance.update({
        where: { id: balance.id },
        data: {
          pendingDays: { decrement: new Prisma.Decimal(totalDays) },
          usedDays: { increment: new Prisma.Decimal(totalDays) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: balance.id,
        entryType: 'CONSUME',
        days: 0,
        referenceType: 'leave_request',
        referenceId: request.id,
        note: `Disetujui: ${request.requestNumber}`,
        actorUserId,
      });
    } else {
      await tx.leaveBalance.update({
        where: { id: balance.id },
        data: {
          pendingDays: { decrement: new Prisma.Decimal(totalDays) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: balance.id,
        entryType: 'RELEASE',
        days: totalDays,
        referenceType: 'leave_request',
        referenceId: request.id,
        note: `Ditolak: ${request.requestNumber}`,
        actorUserId,
      });
    }
  }

  const updated = await tx.leaveRequest.update({
    where: { id: request.id },
    data: {
      status: decision.approve ? 'APPROVED' : 'REJECTED',
      decidedAt: now,
      currentApproverId: null,
      version: { increment: 1 },
    },
    include: { leaveType: { select: { name: true } } },
  });

  await tx.leaveApproval.updateMany({
    where: { requestId: request.id, decision: null },
    data: {
      decision: decision.approve ? 'APPROVED' : 'REJECTED',
      comment: decision.comment,
      decidedAt: now,
    },
  });

  await writeAudit(tx, tenantId, {
    action: decision.approve ? 'leave.request.approved' : 'leave.request.rejected',
    entityType: 'leave_request',
    entityId: request.id,
    actorUserId,
    before: { status: 'PENDING' },
    after: { status: updated.status, comment: decision.comment },
  });

  await publishEvent(tx, tenantId, {
    topic: decision.approve
      ? EventTopic.LEAVE_REQUEST_APPROVED
      : EventTopic.LEAVE_REQUEST_REJECTED,
    payload: {
      requestId: request.id,
      requestNumber: request.requestNumber,
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      startDate: request.startDate.toISOString().slice(0, 10),
      endDate: request.endDate.toISOString().slice(0, 10),
      totalDays,
    },
  });

  return toView(updated);
}

/**
 * Membatalkan pengajuan yang belum diputuskan, oleh pengajunya sendiri.
 *
 * Penahanan saldonya dilepaskan. Tanpa pelepasan, saldo yang ditahan pengajuan
 * yang dibatalkan akan hilang sampai akhir tahun tanpa ada yang memakainya —
 * dan pemiliknya tidak punya cara mengetahui ke mana perginya.
 */
export async function cancelRequest(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  employeeId: string,
  actorUserId: string,
): Promise<void> {
  const request = await tx.leaveRequest.findFirst({
    where: { id: requestId, tenantId },
    include: { leaveType: { select: { deductFromBalance: true } } },
  });
  if (!request) throw new LeaveError('Pengajuan tidak ditemukan', 'not_found');
  if (request.employeeId !== employeeId) {
    throw new LeaveError('Hanya pengaju yang dapat membatalkan', 'forbidden');
  }
  if (request.status !== 'PENDING') {
    throw new LeaveError('Hanya pengajuan yang belum diputuskan dapat dibatalkan', 'invalid_state');
  }

  const totalDays = Number(request.totalDays);

  if (request.leaveType.deductFromBalance) {
    const balance = await lockBalance(
      tx,
      tenantId,
      request.employeeId,
      request.leaveTypeId,
      request.startDate.getUTCFullYear(),
    );
    if (balance) {
      await tx.leaveBalance.update({
        where: { id: balance.id },
        data: {
          pendingDays: { decrement: new Prisma.Decimal(totalDays) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: balance.id,
        entryType: 'RELEASE',
        days: totalDays,
        referenceType: 'leave_request',
        referenceId: request.id,
        note: `Dibatalkan: ${request.requestNumber}`,
        actorUserId,
      });
    }
  }

  await tx.leaveRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED', decidedAt: new Date(), currentApproverId: null },
  });

  await writeAudit(tx, tenantId, {
    action: 'leave.request.cancelled',
    entityType: 'leave_request',
    entityId: request.id,
    actorUserId,
    before: { status: 'PENDING' },
    after: { status: 'CANCELLED' },
  });
}

export async function listRequests(
  tx: TenantClient,
  tenantId: string,
  filter: { employeeId?: string; approverId?: string; status?: string; from?: Date; to?: Date },
): Promise<RequestView[]> {
  const rows = await tx.leaveRequest.findMany({
    where: {
      tenantId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.approverId ? { currentApproverId: filter.approverId } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.from && filter.to
        ? { startDate: { lte: filter.to }, endDate: { gte: filter.from } }
        : {}),
    },
    include: { leaveType: { select: { name: true } } },
    orderBy: [{ startDate: 'desc' }],
    take: 500,
  });

  return rows.map(toView);
}

export interface LeaveOnDate {
  requestId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  isPaid: boolean;
  affectsPayroll: boolean;
}

/**
 * Cuti yang disetujui dan mencakup satu tanggal tertentu.
 *
 * Dipakai kalkulasi presensi harian supaya hari bercuti tidak dihitung alfa.
 * Tanpa ini, status `LEAVE` yang ada di tipe tidak pernah dihasilkan siapa pun,
 * dan seorang karyawan yang cutinya sudah disetujui tetap tercatat ABSENT —
 * lalu dipotong gajinya sebagai mangkir.
 *
 * Diletakkan di pintu depan modul cuti, bukan di-query langsung dari modul
 * presensi. Presensi tidak boleh tahu bentuk tabel cuti; ketika kelak modul cuti
 * dipecah menjadi service, yang berubah hanya isi fungsi ini.
 */
export async function leaveOnDate(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  workDate: Date,
): Promise<LeaveOnDate | null> {
  const row = await tx.leaveRequest.findFirst({
    where: {
      tenantId,
      employeeId,
      status: { in: ['APPROVED', 'TAKEN'] },
      startDate: { lte: workDate },
      endDate: { gte: workDate },
    },
    include: {
      leaveType: { select: { code: true, name: true, isPaid: true, affectsPayroll: true } },
    },
  });

  if (!row) return null;

  return {
    requestId: row.id,
    leaveTypeCode: row.leaveType.code,
    leaveTypeName: row.leaveType.name,
    isPaid: row.leaveType.isPaid,
    affectsPayroll: row.leaveType.affectsPayroll,
  };
}
