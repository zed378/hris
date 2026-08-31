import { log } from '@hrms/observability';
import { runPayrollCalculation } from './payroll-run.ts';
import { notifyLeaveDecision, type LeaveNotifyPayload } from './leave-notify.ts';
import { EventTopic } from '@hrms/contracts';
import { deliverNotification, type NotifiableTopic } from '@hrms/core/notification';
import type { OutboxEnvelope } from './outbox-pump.ts';

/**
 * The consumer catalogue — one decision per event topic.
 *
 * Its shape is `Record<EventTopic, …>` deliberately: TypeScript refuses to
 * compile this file when a new topic is added to the event catalogue without a
 * decision here. What that prevents is not forgetting to write a consumer, but
 * forgetting to DECIDE — and the two have different outcomes.
 *
 * A topic with no consumer produces no error at all. Its queue exists, messages
 * arrive, and the jobs sit in `created` status until pg-boss retention archives
 * them. Nothing fails, nothing tells anyone, and that event simply never
 * happened for whoever was waiting on it.
 *
 * So a `drain` has to be written explicitly, with its reason. "No effect yet" is
 * a legitimate decision; what is not legitimate is being unable to see that the
 * decision was ever taken.
 */

export type Consumer =
  | { kind: 'handle'; run: (envelope: OutboxEnvelope) => Promise<void> }
  | { kind: 'drain'; reason: string };

/** Topics that become email. Their idempotency lives in `notification_logs.dedupeKey`. */
function notify(topic: NotifiableTopic): Consumer {
  return {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const result = await deliverNotification(tenantId, topic, payload);
      if (result.status !== 'skipped') {
        // The `correlationId` is carried from the outbox envelope — this is the
        // join that keeps one request's trail whole across the queue boundary.
        // Without it, the worker log is an island that cannot be connected to any
        // request.
        log.info({ scope: 'notification', topic, correlationId: correlationId ?? undefined, ...result });
      }
    },
  };
}

/**
 * Tells an employee their leave has been decided.
 *
 * What is missing and deliberately not added here: an automatic recompute of
 * the attendance recap over the leave range. `calculateDay` reads leave straight
 * from the database, so the recap is already right once computed — all that is
 * missing is the trigger, and adding it would make one consumer do two things
 * that fail for different reasons.
 */
function leaveDecision(approved: boolean): Consumer {
  return {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const result = await notifyLeaveDecision(
        tenantId,
        payload as LeaveNotifyPayload,
        approved,
      );
      if (result.sent > 0 || result.pruned > 0) {
        log.info({ scope: 'leave-notify', correlationId: correlationId ?? undefined, tenantId, approved, ...result });
      }
    },
  };
}

export const CONSUMERS: Record<EventTopic, Consumer> = {
  [EventTopic.PASSWORD_RESET_REQUESTED]: notify('auth.password.reset_requested'),
  [EventTopic.USER_INVITED]: notify('iam.user.invited'),
  [EventTopic.CONTRACT_EXPIRING]: notify('employee.contract.expiring'),
  [EventTopic.DOCUMENT_EXPIRING]: notify('employee.document.expiring'),

  /**
   * The payroll calculation.
   *
   * The only consumer that does heavy work rather than sending a message. Its
   * reason is in `payroll-run.ts`: a thousand-employee calculation cannot finish
   * inside an HTTP request transaction, and what happens is not "slow" but a
   * rolled-back transaction that loses every payslip already computed.
   *
   * Errors are DELIBERATELY rethrown rather than swallowed as in the other
   * consumers. pg-boss will retry, and retrying is safe here precisely because
   * the finished chunks are committed: the next attempt continues rather than
   * restarting. Swallowing would leave a run half finished with nobody trying to
   * complete it.
   */
  [EventTopic.PAYROLL_RUN_REQUESTED]: {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const { runId, actorUserId } = payload as { runId: string; actorUserId: string };
      const result = await runPayrollCalculation(tenantId, runId, actorUserId);
      log.info({ scope: 'payroll-run', correlationId: correlationId ?? undefined, tenantId, ...result });
    },
  },

  /**
   * A punch flagged for review.
   *
   * Logging only for now: the HR review queue is read straight from the
   * database, not from events. What is missing is the realtime push to the HR
   * dashboard (Phase 3, SSE) — and when that is built, its place is here.
   */
  [EventTopic.PUNCH_FLAGGED]: {
    kind: 'handle',
    async run({ tenantId, payload, correlationId }) {
      const { punchId, trustScore, flags } = payload as {
        punchId?: string;
        trustScore?: number;
        flags?: string[];
      };
      log.info({
        scope: 'punch-flagged',
        correlationId: correlationId ?? undefined,
        tenantId,
        punchId,
        trustScore,
        flags,
      });
    },
  },

  /**
   * Leave approved — attendance has to know.
   *
   * A day on leave must not be counted absent (P4 scope). The daily calculation
   * reads leave straight from the database, so this event has no effect yet;
   * what is missing is an automatic recompute trigger over the leave range.
   */
  [EventTopic.LEAVE_REQUEST_APPROVED]: leaveDecision(true),
  [EventTopic.LEAVE_REQUEST_REJECTED]: leaveDecision(false),
  [EventTopic.LEAVE_REQUEST_SUBMITTED]: {
    kind: 'drain',
    reason: 'inbox approver realtime, F4 lanjutan',
  },
  [EventTopic.LEAVE_BALANCE_CHANGED]: { kind: 'drain', reason: 'widget saldo di dasbor, F6' },

  // The audit and metrics streams. All of it is already recorded in the database
  // in the same transaction; the events exist for consumers not yet built.
  [EventTopic.TENANT_PROVISIONED]: { kind: 'drain', reason: 'onboarding otomatis, Fase 6' },
  [EventTopic.TENANT_MODULE_ENABLED]: { kind: 'drain', reason: 'penagihan berbasis modul, Fase 6' },
  [EventTopic.TENANT_MODULE_DISABLED]: { kind: 'drain', reason: 'penagihan berbasis modul, Fase 6' },
  [EventTopic.TENANT_SUSPENDED]: { kind: 'drain', reason: 'pemberitahuan penangguhan, Fase 6' },

  [EventTopic.USER_LOGGED_IN]: { kind: 'drain', reason: 'metrik kesehatan tenant, Fase 6' },
  [EventTopic.USER_LOGIN_FAILED]: { kind: 'drain', reason: 'deteksi anomali masuk, Fase 6' },
  [EventTopic.SESSION_REVOKED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },
  [EventTopic.TOKEN_REUSE_DETECTED]: { kind: 'drain', reason: 'peringatan keamanan, Fase 6' },

  [EventTopic.ACCESS_CHANGED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },
  [EventTopic.ROLE_ASSIGNED]: { kind: 'drain', reason: 'sudah lengkap di audit_logs' },

  [EventTopic.EMPLOYEE_CREATED]: { kind: 'drain', reason: 'penyediaan akun otomatis, Fase 4' },
  [EventTopic.EMPLOYEE_IMPORT_COMMITTED]: { kind: 'drain', reason: 'ringkasan impor ke HR, Fase 4' },
};
