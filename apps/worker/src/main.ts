import { log } from '@hrms/observability';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { disconnectAll } from '@hrms/db';
import { EventTopic } from '@hrms/contracts';
import { createBroker } from './broker.ts';
import { countStuck, pumpOnce } from './outbox-pump.ts';
import { runContractReminders } from './contract-reminders.ts';
import { runPhotoRetention } from './photo-retention.ts';
import { runLeaveAccrual } from './leave-accrual.ts';
import { runSchemaDriftCheck } from './schema-drift.ts';
import { CONSUMERS, type Consumer } from './consumers.ts';

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

/**
 * The background process.
 *
 * Deliberately separate from `apps/web`, even though both are one codebase. This
 * is the damper for risk N2 (PLAN/12 §10.3): heavy work — Excel import, payroll
 * runs, PDF generation — must not hold up a user request. A process split is the
 * cheapest way to guarantee that without breaking the system into services.
 */

const POLL_INTERVAL_MS = 2000;

async function main(): Promise<void> {
  /**
   * The broker is chosen by configuration (PLAN/14 stage 7).
   *
   * pg-boss unless `BROKER_URL` says otherwise, which means the ordinary
   * deployment gains no new container and no new failure mode. Everything below
   * is written against the interface, so the choice is the only line that knows
   * which one is running.
   */
  const broker = createBroker();
  await broker.start(Object.values(EventTopic));

  log.info({ scope: 'worker', event: 'broker-ready', kind: broker.kind });

  /**
   * Consumer registration.
   *
   * Every consumer MUST be idempotent: the outbox guarantees at-least-once, not
   * exactly-once, so the same message can arrive twice and that is not a bug.
   * For email, its idempotency lives in the `dedupeKey` on notification_logs —
   * not in a hope that a message will never be resent.
   *
   * A handling failure does NOT throw. Throwing would make the broker retry, and
   * retrying a genuinely wrong email address only produces the same failure over
   * and over. The failure is recorded on its own row, where it can be seen and
   * acted on.
   */
  for (const [topic, consumer] of Object.entries(CONSUMERS) as Array<[EventTopic, Consumer]>) {
    if (consumer.kind === 'drain') {
      // Drained with no effect. Its reason is in the consumer catalogue, not here.
      await broker.subscribe(topic, async () => {});
      continue;
    }

    await broker.subscribe(topic, async (envelope) => {
      try {
        await consumer.run(envelope);
      } catch (error) {
        log.error({ scope: 'consumer', topic, error });
      }
    });
  }

  let running = true;
  const stop = async (signal: string): Promise<void> => {
    if (!running) return;
    running = false;
    log.info({ scope: 'worker', event: 'shutdown', signal });
    await broker.stop();
    await disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  /**
   * Contract reminders run once a day.
   *
   * Triggered by an interval rather than cron, because the scan is idempotent: a
   * unique constraint on (contractId, threshold) means a second call on the same
   * day publishes nothing. That removes an entire class of scheduling problem —
   * a worker restarting three times a day is still correct, and no window is
   * missed when one round fails.
   *
   * Run once at startup so the first deploy does not wait 24 hours for its first
   * reminder.
   */
  const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const runReminders = async (): Promise<void> => {
    try {
      const result = await runContractReminders();
      if (result.reminded > 0 || result.failed > 0 || result.discardedPreviews > 0 || result.orphanAttachments > 0) {
        log.info({ scope: 'contract-reminders', ...result });
      }
    } catch (error) {
      log.error({ scope: 'contract-reminders', error });
    }
  };

  /**
   * Attendance photo retention runs alongside the contract reminders.
   *
   * Idempotent by nature: what it looks for are photos past their
   * `photoExpiresAt`, and once deleted they no longer appear in that search. A
   * worker restarting many times a day stays correct.
   */
  const runRetention = async (): Promise<void> => {
    try {
      const result = await runPhotoRetention();
      if (result.deleted > 0 || result.failed > 0 || result.alreadyGone > 0) {
        log.info({ scope: 'photo-retention', ...result });
      }
    } catch (error) {
      log.error({ scope: 'photo-retention', error });
    }
  };

  /**
   * The schema drift check.
   *
   * Runs alongside the other daily jobs, and once immediately when the worker
   * starts. What it looks for is a production database state no migration
   * describes — a `tenant_id` table without RLS, RLS with no policy, or an
   * application role that can bypass RLS.
   *
   * Running it at startup is deliberate: if something broke overnight, the
   * morning restart is the earliest chance to find out.
   */
  const runDriftCheck = async (): Promise<void> => {
    try {
      await runSchemaDriftCheck();
    } catch (error) {
      log.error({ scope: 'schema-drift', error });
    }
  };

  /**
   * Leave allowance accrual.
   *
   * Daily and idempotent, for the same reason as the contract reminders: it
   * compares the existing allowance against the allowance that should have been
   * earned by today, rather than adding a month on every call. A worker
   * restarting five times a day stays correct, and a worker dead for three
   * months catches up on its first round after starting.
   */
  const runAccrualJob = async (): Promise<void> => {
    try {
      const result = await runLeaveAccrual();
      if (result.accrued > 0 || result.failed > 0 || result.jointLeaveDays > 0) {
        log.info({ scope: 'leave-accrual', ...result });
      }
    } catch (error) {
      log.error({ scope: 'leave-accrual', error });
    }
  };

  void runReminders();
  void runRetention();
  void runDriftCheck();
  void runAccrualJob();
  const reminderTimer = setInterval(() => {
    void runReminders();
    void runRetention();
    void runDriftCheck();
    void runAccrualJob();
  }, REMINDER_INTERVAL_MS);
  reminderTimer.unref?.();

  log.info({ scope: 'worker', event: 'started', outboxIntervalMs: POLL_INTERVAL_MS });

  while (running) {
    try {
      const stats = await pumpOnce(broker);
      if (stats.published > 0 || stats.failed > 0) {
        log.info({ scope: 'outbox', ...stats });
      }
      const stuck = await countStuck();
      if (stuck > 0) log.warn({ scope: 'outbox', stuck });
    } catch (error) {
      log.error({ scope: 'outbox-pump', error });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  log.error({ scope: 'worker', event: 'fatal', error });
  process.exit(1);
});
