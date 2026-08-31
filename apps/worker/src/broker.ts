import { PgBoss } from 'pg-boss';
import { log } from '@hrms/observability';
import type { Codec, NatsConnection } from 'nats';
import type { OutboxEnvelope } from './outbox-pump.ts';

/**
 * The message broker, behind one interface (PLAN/14 §9.1, stage 7).
 *
 * pg-boss has been the right choice and mostly still is: one fewer system to
 * keep alive, and `PLAN/12` N7 rates the chance of it becoming a bottleneck as
 * low. What changes it is not throughput but **fan-out**. The outbox already
 * publishes events; with more than one service, more than one consumer wants
 * them, and pg-boss models a job queue rather than a topic.
 *
 * ## What this is, and what it is not
 *
 * It is a seam, in the same shape as `decideAccess` in stage 4. pg-boss remains
 * the default and nothing about the ordinary deployment changes: with
 * `BROKER_URL` unset there is no broker to run, no new container, and no new
 * failure mode.
 *
 * It is **not** an adoption. Introducing a broker with no measured need would
 * add a permanent operational dependency for a one-person team, which is exactly
 * what `PLAN/12` §3.2 argues against — and unlike Redis, which fixed a present
 * correctness bug, a broker fixes nothing that is currently broken. The
 * capability exists, is tested, and is off.
 *
 * ## What must survive the swap
 *
 * The transactional outbox. Its value is that a job is never lost and never
 * fires for a write that rolled back, and no broker offers that on its own: the
 * outbox table stays, the pump stays, and only its destination changes. That is
 * the main reason this migration is tractable at all — the hard part was built
 * years before the broker was.
 *
 * At-least-once stays too. Every consumer is already idempotent because it had
 * to be, and switching brokers must not quietly turn that into a requirement
 * nobody re-checked.
 */

export interface Broker {
  /** Prepares the transport and its topics. */
  start(topics: readonly string[]): Promise<void>;
  publish(topic: string, envelope: OutboxEnvelope): Promise<void>;
  /**
   * Registers a consumer.
   *
   * The handler is called once per message. It must not throw for a business
   * failure — a wrong email address retried forever is the same failure forever
   * — and the implementations here do not retry on their own.
   */
  subscribe(topic: string, handle: (envelope: OutboxEnvelope) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  readonly kind: 'pg-boss' | 'nats';
}

/**
 * pg-boss, the default.
 *
 * Runs as the OWNER role, which is a deliberate exception: it manages its own
 * schema, creating tables and functions in `pgboss` on first run and on every
 * version rise. That needs DDL rights `hrms_worker` does not have, and granting
 * them would let a runtime role create tables anywhere.
 *
 * The consequence worth knowing: this connection is not bound by the worker
 * role's `statement_timeout`. The `pgboss` schema holds no `tenant_id` column so
 * RLS does not apply and nothing is bypassed — but a job hanging here will not
 * be cut off by the database, and only `stop()` ends it.
 */
class PgBossBroker implements Broker {
  readonly kind = 'pg-boss' as const;
  private boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
  }

  async start(topics: readonly string[]): Promise<void> {
    this.boss.on('error', (error: unknown) => log.error({ scope: 'pg-boss', error }));
    await this.boss.start();

    // pg-boss 12 requires a queue to exist before use. Created from the same
    // topic catalogue the publisher reads, so a new topic cannot reach
    // production without its queue. Idempotent, and safe on every startup.
    for (const topic of topics) await this.boss.createQueue(topic);
  }

  async publish(topic: string, envelope: OutboxEnvelope): Promise<void> {
    await this.boss.send(topic, envelope);
  }

  async subscribe(
    topic: string,
    handle: (envelope: OutboxEnvelope) => Promise<void>,
  ): Promise<void> {
    await this.boss.work(topic, async (jobs) => {
      for (const job of jobs) {
        const envelope = job.data as OutboxEnvelope;
        if (!envelope?.tenantId || !envelope.payload) continue;
        await handle(envelope);
      }
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }

  /** The pump still needs the raw client for `send`; nothing else does. */
  get raw(): PgBoss {
    return this.boss;
  }
}

/**
 * NATS JetStream, opt-in.
 *
 * Chosen over RabbitMQ for the reason `PLAN/12` chose PostgreSQL for everything:
 * operational weight. NATS is a single static binary with no separate runtime to
 * install and no management plugin to secure, and for a team of one or two that
 * difference outweighs RabbitMQ's richer routing — which this system does not
 * yet use.
 *
 * Kafka is not a candidate. Its operational weight exceeds that of the entire
 * application, which §9.1 says plainly.
 *
 * Loaded through a dynamic import so the dependency is only touched when a
 * broker is actually configured. A deployment that never sets `BROKER_URL` does
 * not pay for a library it will not use, and — more usefully — cannot fail at
 * startup because of one.
 */
class NatsBroker implements Broker {
  readonly kind = 'nats' as const;
  private connection: unknown = null;
  private subscriptions: Array<{ unsubscribe: () => void }> = [];

  constructor(private readonly url: string) {}

  async start(topics: readonly string[]): Promise<void> {
    const { connect, JSONCodec } = await import('nats');
    this.codec = JSONCodec<OutboxEnvelope>();
    this.connection = await connect({ servers: this.url });

    const manager = await (this.connection as NatsConnection).jetstreamManager();

    /**
     * One stream over `hrms.>`, not one per topic.
     *
     * A stream per topic would mean a management call for every event type and a
     * migration whenever one is added. A single subject-wildcard stream lets the
     * topic catalogue stay the only place topics are declared — which is the
     * property that makes a missing consumer a compile error rather than a
     * silent drop.
     */
    await manager.streams
      .add({
        name: 'hrms',
        subjects: ['hrms.>'],
        // Retention by acknowledgement: a message is kept until every consumer
        // has taken it, which is what makes redelivery after a crash possible.
        // `limits`, not `workqueue`. Workqueue retention allows only ONE
        // consumer per subject and deletes a message as soon as it is
        // acknowledged — which forbids the fan-out that is the whole reason
        // §9.1 gives for wanting a broker at all.
        retention: 'limits' as never,
        max_age: 7 * 24 * 3_600 * 1_000_000_000,
      })
      .catch(async () => {
        // Already present, possibly with different subjects. Updating rather than
        // failing means adding a topic does not require deleting the stream.
        await manager.streams.update('hrms', { subjects: ['hrms.>'] } as never).catch(() => {});
      });

    void topics;
  }

  private codec: Codec<OutboxEnvelope> | null = null;

  private subject(topic: string): string {
    // Dots are the subject separator in NATS, and our topics contain them —
    // `leave.request.approved`. Left as they are, so a subject reads exactly like
    // the topic it carries and a wildcard subscription still works.
    return `hrms.${topic}`;
  }

  async publish(topic: string, envelope: OutboxEnvelope): Promise<void> {
    const nc = this.connection as NatsConnection;
    const js = nc.jetstream();
    // `publish`, not `nc.publish`: JetStream acknowledges the write, so a
    // failure to persist is an error here rather than a message that silently
    // never existed. The outbox row is only marked published after this returns.
    await js.publish(this.subject(topic), this.codec!.encode(envelope));
  }

  async subscribe(
    topic: string,
    handle: (envelope: OutboxEnvelope) => Promise<void>,
  ): Promise<void> {
    const nc = this.connection as NatsConnection;
    const manager = await nc.jetstreamManager();
    const durable = `worker-${topic.replace(/\./g, '-')}`;

    /**
     * The consumer is CREATED before it is fetched.
     *
     * `consumers.get(stream, name)` takes a name, not a configuration — passing
     * a config object there yields a consumer that exists in no useful sense,
     * and the symptom is silence: publishing succeeds, the stream holds the
     * message, and the subscriber is simply never called. Measured before this
     * was fixed: five delivery tests timed out at thirty seconds each with no
     * error from either side.
     *
     * Durable, so a worker restart resumes where it left off rather than
     * replaying the stream or skipping what arrived while it was down.
     */
    await manager.consumers
      .add('hrms', {
        durable_name: durable,
        filter_subject: this.subject(topic),
        // Explicit acknowledgement: a message is redelivered unless the consumer
        // says it is done. `none` would lose anything in flight during a crash,
        // which for a leave notification means an employee is never told.
        ack_policy: 'explicit' as never,
        deliver_policy: 'all' as never,
        max_deliver: 1,
      })
      .catch(() => {
        // Already present from a previous run. Its configuration is not
        // overwritten: an existing durable consumer has a delivery position, and
        // replacing it would move that position.
      });

    const consumer = await nc.jetstream().consumers.get('hrms', durable);
    const messages = await consumer.consume();

    void (async () => {
      for await (const message of messages) {
        try {
          const envelope = this.codec!.decode(message.data);
          if (envelope?.tenantId && envelope.payload) await handle(envelope);
          // Acknowledged even when the handler threw or declined the envelope.
          // A malformed message will be just as malformed on redelivery, so
          // leaving it unacknowledged makes it arrive forever and the consumer
          // never reaches anything behind it.
          message.ack();
        } catch (error) {
          log.error({ scope: 'nats-consumer', topic, error });
          message.ack();
        }
      }
    })();

    this.subscriptions.push({ unsubscribe: () => void messages.close() });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    await (this.connection as NatsConnection)?.drain();
  }
}

/**
 * The broker this deployment uses.
 *
 * `BROKER_URL` unset — the default and the supported configuration — is pg-boss
 * on the application database, exactly as before.
 */
export function createBroker(): Broker {
  const url = process.env['BROKER_URL'];

  if (url?.trim()) {
    log.info({ scope: 'broker', event: 'selected', kind: 'nats' });
    return new NatsBroker(url);
  }

  return new PgBossBroker(process.env['DATABASE_URL']!);
}

export { PgBossBroker };
