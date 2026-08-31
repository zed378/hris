import { EventTopic } from '@hrms/contracts';
import { publishEvent, type TenantClient } from '@hrms/db';
import type { ReminderScanResult, ReminderThreshold } from './contracts.ts';

/**
 * Reminders for employee documents about to expire (document 09 §6).
 *
 * `employee_documents.expires_at` has existed since the document module was
 * built, with a comment reading "for documents that genuinely age — work
 * permits, driving licences, contracts". HR fills it in. Then the date passes,
 * and nothing happens: no code path ever read that column.
 *
 * What passes is more than a date in a database:
 *
 *   - **An expired work permit** = a foreign worker working without
 *     authorisation. A criminal offence for the company under Immigration Law
 *     6/2011, and deportation for the person.
 *   - **An expired driving licence** = a company driver driving unlicensed, and
 *     the vehicle insurance void on the first accident.
 *
 * Both are only discovered when someone inspects — and the inspector is usually
 * not HR.
 *
 * Its shape is deliberately identical to `scanContractReminders`, down to the
 * threshold names. Two jobs doing similar work in different shapes are two jobs
 * that have to be understood separately, and the second one will be wrong.

/** Document kinds not worth reminding about, even with an expiry date. */
const IGNORED_KINDS = new Set(['KONTRAK']);

export async function scanDocumentReminders(
  tx: TenantClient,
  tenantId: string,
): Promise<ReminderScanResult> {
  const today = startOfDay(new Date());
  let reminded = 0;

  const documents = await tx.employeeDocument.findMany({
    where: {
      tenantId,
      expiresAt: { not: null, gte: new Date(today.getTime() - 30 * 86_400_000) },
      // An archived document is not reminded about. Archiving is how HR states a
      // document no longer applies — reminding about it means asking for action
      // on a decision already taken.
      archivedAt: null,
    },
    select: {
      id: true,
      kind: true,
      title: true,
      expiresAt: true,
      employeeId: true,
      reminders: { select: { threshold: true } },
    },
  });

  // Employees are read separately rather than through a relation.
  //
  // `employee_documents.employee_id` has no foreign key in the database — a state
  // found while writing this file, not one that was designed — and Prisma
  // therefore does not know the relation. Adding that FK is a schema change of
  // its own that first has to check for orphan rows, and slipping it into this
  // change would put two different things in one migration.
  //
  // An employee who is NOT found is skipped. A document belonging to someone who
  // has left, or whose row is gone, produces a reminder to nobody — and its
  // silence here is right: there is no action to take on the work permit of
  // someone who no longer works here.
  const employees = await tx.employee.findMany({
    where: {
      tenantId,
      id: { in: [...new Set(documents.map((d) => d.employeeId))] },
      status: { in: ['ACTIVE', 'PROBATION'] },
    },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  for (const document of documents) {
    const employee = byId.get(document.employeeId);
    if (!employee) continue;

    // Contracts have a reminder path of their own, with a different legal warning
    // (a lapsed fixed-term contract becomes permanent by operation of law).
    // Sending both means HR receives two emails for one event, and the second
    // says less than the first.
    if (IGNORED_KINDS.has(document.kind.toUpperCase())) continue;

    const daysLeft = Math.round(
      (startOfDay(document.expiresAt!).getTime() - today.getTime()) / 86_400_000,
    );
    const sent = new Set(document.reminders.map((r) => r.threshold));

    // The highest threshold already passed, not all of them. A document uploaded
    // when 20 days remain need not receive three reminders at once.
    const due: ReminderThreshold | null =
      daysLeft < 0 ? 'EXPIRED'
      : daysLeft <= 7 ? 'D7'
      : daysLeft <= 30 ? 'D30'
      : daysLeft <= 90 ? 'D90'
      : null;

    if (!due || sent.has(due)) continue;

    try {
      await tx.documentReminder.create({
        data: { tenantId, documentId: document.id, threshold: due },
      });
    } catch {
      // A unique constraint refuses duplicates. Two jobs running at once — which
      // happens when a deploy coincides with the schedule — will make one of them
      // fail here, and that is the right behaviour.
      continue;
    }

    await publishEvent(tx, tenantId, {
      topic: EventTopic.DOCUMENT_EXPIRING,
      payload: {
        tenantId,
        documentId: document.id,
        kind: document.kind,
        title: document.title,
        expiresAt: document.expiresAt!.toISOString().slice(0, 10),
        daysLeft,
        threshold: due,
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        employeeName: employee.fullName,
      },
    });

    reminded += 1;
  }

  return { scanned: documents.length, reminded };
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
