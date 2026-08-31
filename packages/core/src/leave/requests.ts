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
 * Leave requests and approvals (PLAN/12 P4).
 *
 * The balance flow is deliberately three steps, not two:
 *
 *   request              → HOLD    (`pending_days` rises)
 *   approval             → CONSUME (`pending_days` falls, `used_days` rises)
 *   rejection / cancellation → RELEASE (`pending_days` falls)
 *
 * That HOLD step is what stops someone requesting three two-day leaves against
 * a two-day balance and then waiting for all three to be approved. Without the
 * hold, every request sees the balance still whole because nothing has deducted
 * from it yet — and the excess only surfaces when the third approval is refused
 * by the database, after two managers have already approved.
 */

/**
 * An employee's weekly days off, read from their schedule.
 *
 * Keyed by ISO date (`YYYY-MM-DD`); a value of `true` means that day is
 * SCHEDULED OFF for this person. A date with no key falls back to the
 * Monday–Friday assumption.
 */
export type DayOffMap = ReadonlyMap<string, boolean>;

/**
 * How many working days fall in a range, excluding weekly days off and holidays.
 *
 * Saturday and Sunday are only a **last-resort assumption**, not a rule. That
 * assumption is wrong for most of the tenants this product targets: a six-day
 * factory, a shop that closes on Mondays, three-shift security guards whose days
 * off rotate. In a six-day factory, a Monday–Saturday request deducted five days
 * of balance while six working days were missed — the company lost a working day
 * every time, and nothing revealed it because the number still looked plausible.
 * akal.
 *
 * The right answer lives in `attendance.schedules`: one row per employee per
 * date, with an `is_day_off` the attendance module already uses to decide
 * `DAY_OFF` status. Leave now reads the same source, so attendance and leave
 * cannot disagree about which days are working days.
 *
 * A date with no schedule row falls back to Monday–Friday. A tenant who has not
 * scheduled anything therefore sees no change in behaviour.
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

    // A schedule beats the weekend assumption — in BOTH directions. A Saturday
    // scheduled on counts as a working day; a Monday scheduled off does not.
    // Letting a schedule only reduce working days would be wrong for a six-day
    // factory, which increases them instead.
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
  /** The user who will decide. A tiered flow follows when a tenant needs one. */
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

/** A human-readable request number: `CUTI-2026-000123`. */
async function nextRequestNumber(tx: TenantClient, tenantId: string, year: number): Promise<string> {
  const count = await tx.leaveRequest.count({
    where: { tenantId, requestNumber: { startsWith: `CUTI-${year}-` } },
  });
  return `CUTI-${year}-${String(count + 1).padStart(6, '0')}`;
}

/**
 * Requests leave, and holds its balance at the same time.
 *
 * All in one transaction. A balance hold separate from creating the request
 * would leave one without the other if the process died in between — and both
 * are equally bad: a hold with no request cannot be released by anyone, and a
 * request with no hold removes the entire point of holding.
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
   * A mandatory attachment means a FILE that was genuinely uploaded.
   *
   * Before this the check was only `!input.attachmentKey` over a free-text
   * column, and the screen showed an input box labelled "Number or name of the
   * doctor's note file". Which means the requirement "a doctor's note is
   * mandatory" was satisfied by typing the word "ada".
   *
   * For sick leave, that doctor's note is the only thing separating paid leave
   * from absence. A requirement that accepts arbitrary text is not a
   * requirement; it is an input box that makes everyone believe evidence is
   * stored.
  let attachmentId: string | null = null;

  if (type.requiresAttachment) {
    if (!input.attachmentKey) {
      throw new LeaveError(
        `${type.name} wajib menyertakan lampiran, mis. surat dokter. Unggah berkasnya lebih dulu.`,
        'invalid_state',
      );
    }
    // Throws when the key is fabricated, belongs to someone else, or has already
    // been used by another request.
    attachmentId = (await claimAttachment(tx, tenantId, input.employeeId, input.attachmentKey)).id;
  } else if (input.attachmentKey) {
    // An optional attachment still has its ownership checked. A leave type that
    // does not require one is no reason to accept someone else's key.
    attachmentId = (await claimAttachment(tx, tenantId, input.employeeId, input.attachmentKey)).id;
  }

  // Minimum length of service. The Labour Law requires 12 months for annual
  // leave, and a tenant may set something more lenient but not stricter through
  // `minServiceMonths`.
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

  // This employee's schedule over the requested range. Only rows that genuinely
  // exist are fetched — the absence of a row means "use the Monday–Friday
  // assumption", not "a day off".
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

    // Validation AFTER the lock is held. Reading before the lock means deciding
    // on a value that may already have changed.
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
    // The EXCLUDE constraint refuses an overlap. Its message is translated here
    // because a raw database error cannot be read by its user, and because this
    // is the only place that knows what is meant is leave.
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

  // Adopted after its request exists — the uploader does not know the id when
  // they upload, so an attachment is always born an orphan.
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
 * Deciding a leave request.
 *
 * The balance row is locked BEFORE the request status is checked, and that
 * order is deliberate. Fifty simultaneous approvals of the same request queue
 * on the balance lock; the first changes the status to APPROVED, and the other
 * forty-nine read that status once the lock is released — then stop, because it
 * is no longer PENDING.
 *
 * Locking after checking the status would invert that: fifty transactions would
 * all read PENDING, then queue up to write.
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

  /**
   * Who may decide.
   *
   * Two control failures are closed here, and both were found by trying it, not
   * by reading the code.
   *
   * **`currentApproverId` was written but never read.** The requester picks
   * their approver, the system records it, and then ignores it entirely: anyone
   * holding `leave.request.approve` could decide anyone's request. That column
   * merely decorated the inbox.
   *
   * **A requester could approve their own leave.** A manager holding the
   * approval permission — and managers do hold it — could request leave and then
   * approve it themselves in two clicks. There was not one check in between,
   * and the result is indistinguishable from a legitimate approval.
   *
   * The rule is now two sentences:
   *
   *   1. Self-approval is REFUSED, without exception. There is no conditional
   *      escape hatch: a conditional escape hatch is a hole waiting for its
   *      condition to be met.
   *   2. Someone other than the designated approver may still decide — HR must
   *      be able to stand in for a manager who is on leave or has left, and a
   *      system demanding the exact approver would freeze requests every time
   *      somebody resigns. But that substitution is RECORDED, and that is its
   *      value: what cannot be prevented must be visible.
   */
  const actor = await tx.user.findFirst({
    where: { id: actorUserId, tenantId },
    select: { email: true },
  });
  const actorEmployee = actor
    ? await tx.employee.findFirst({
        where: { tenantId, email: actor.email },
        select: { id: true },
      })
    : null;

  if (actorEmployee && actorEmployee.id === request.employeeId) {
    throw new LeaveError(
      'Anda tidak dapat memutuskan pengajuan cuti Anda sendiri. ' +
        'Tunjuk penyetuju lain saat mengajukan, atau minta HR yang memutuskan.',
      'forbidden',
    );
  }

  const menggantikan =
    request.currentApproverId !== null && request.currentApproverId !== actorUserId;

  const periodYear = request.startDate.getUTCFullYear();
  const balance = request.leaveType.deductFromBalance
    ? await lockBalance(tx, tenantId, request.employeeId, request.leaveTypeId, periodYear)
    : null;

  // Read AGAIN after the lock. The value in `request` above comes from before the
  // lock was held, and across 50 simultaneous requests it is almost certainly stale.
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
      // The hold becomes usage. The available balance does not change at this
      // step — it already fell when the request was made.
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
      // The substitution is marked inside the comment, not in a separate column.
      // This comment is what a person reads when tracing a decision back; a
      // marker in another column is a marker its reader will never see.
      comment: menggantikan
        ? `[diputuskan bukan oleh penyetuju yang ditunjuk] ${decision.comment}`
        : decision.comment,
      decidedAt: now,
    },
  });

  await writeAudit(tx, tenantId, {
    action: decision.approve ? 'leave.request.approved' : 'leave.request.rejected',
    entityType: 'leave_request',
    entityId: request.id,
    actorUserId,
    before: { status: 'PENDING', designatedApproverId: request.currentApproverId },
    after: {
      status: updated.status,
      comment: decision.comment,
      // What cannot be prevented must be visible. HR standing in for a manager
      // who is on leave is normal; HR standing in on every single request is a
      // pattern worth asking about, and that question can only be asked when the
      // data exists.
      overrodeDesignatedApprover: menggantikan,
    },
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
 * Cancelling an undecided request, by the requester themselves.
 *
 * Its balance hold is released. Without the release, the balance held by a
 * cancelled request would be lost until year end with nobody using it — and its
 * owner would have no way of knowing where it went.
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
 * The approved leave covering a particular date.
 *
 * Used by the daily attendance calculation so a day on leave is not counted
 * absent. Without this, the `LEAVE` status present in the type is never produced
 * by anyone, and an employee whose leave has been approved is still recorded
 * ABSENT — and then docked pay as absent.
 *
 * Placed at the leave module's front door rather than queried directly from the
 * attendance module. Attendance must not know the shape of the leave tables;
 * when the leave module is eventually split into a service, only the body of
 * this function changes.
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
