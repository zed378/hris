import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { createBroker, type Broker } from '../src/broker.ts';
import type { OutboxEnvelope } from '../src/outbox-pump.ts';

/**
 * The broker seam, against a real NATS (PLAN/14 stage 7).
 *
 * What has to be true is that a message published on one connection is received
 * on another, acknowledged, and not redelivered — and none of that can be shown
 * by a fake, which would only confirm that the fake calls the callback it was
 * handed.
 *
 * The stakes: every event in this system reaches its consumer through this
 * interface. A broker that loses messages loses leave notifications, contract
 * expiry reminders, and payroll runs, and it loses them silently — the outbox
 * row is marked published either way.
 *
 * ## When NATS is not running
 *
 * These skip and say so. NATS is opt-in and off by default (`BROKER_URL` unset),
 * so a developer without it must not be looking at a red build. Recorded in
 * PLAN/13 so the skip does not pass for coverage.
 */

const url = process.env['BROKER_URL'] ?? 'nats://localhost:4222';

async function probe(): Promise<boolean> {
  try {
    const { connect } = await import('nats');
    const nc = await connect({ servers: url, timeout: 1_500 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

const available = await probe();

if (!available) {
  console.warn(
    'NATS tidak berjalan — uji broker dilewati. Jalankan: ' +
      'docker run -d --name hrms-nats -p 4222:4222 nats:alpine -js',
  );
}

const started: Broker[] = [];

async function brokerFor(topics: string[]): Promise<Broker> {
  process.env['BROKER_URL'] = url;
  const broker = createBroker();
  await broker.start(topics);
  started.push(broker);
  return broker;
}

afterAll(async () => {
  for (const broker of started) await broker.stop().catch(() => undefined);
});

const envelope = (tenantId: string): OutboxEnvelope => ({
  tenantId,
  correlationId: randomUUID(),
  payload: { hello: 'world' },
});

describe.skipIf(!available)('the NATS broker', () => {
  it('reports which implementation is in use', async () => {
    const broker = await brokerFor([]);
    expect(broker.kind).toBe('nats');
  });

  it('delivers a published message to a subscriber', async () => {
    const topic = `test.deliver.${randomUUID().slice(0, 8)}`;
    const broker = await brokerFor([topic]);

    const received: OutboxEnvelope[] = [];
    await broker.subscribe(topic, async (message) => {
      received.push(message);
    });

    const tenant = randomUUID();
    await broker.publish(topic, envelope(tenant));

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
    expect(received[0]).toMatchObject({ tenantId: tenant, payload: { hello: 'world' } });
  });

  /**
   * The envelope must survive the round trip intact.
   *
   * The business payload sits one level inside, not at the root — and a consumer
   * that forgets does not fail, it reads `undefined` for every field. The
   * correlation id matters just as much: it is the join that keeps one request's
   * trail whole across the queue boundary, and losing it turns the worker log
   * into an island.
   */
  it('preserves the envelope, correlation id included', async () => {
    const topic = `test.envelope.${randomUUID().slice(0, 8)}`;
    const broker = await brokerFor([topic]);

    const received: OutboxEnvelope[] = [];
    await broker.subscribe(topic, async (message) => {
      received.push(message);
    });

    const sent = envelope(randomUUID());
    await broker.publish(topic, sent);

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
    expect(received[0]).toEqual(sent);
  });

  it('keeps topics apart', async () => {
    const wanted = `test.a.${randomUUID().slice(0, 8)}`;
    const other = `test.b.${randomUUID().slice(0, 8)}`;
    const broker = await brokerFor([wanted, other]);

    const received: OutboxEnvelope[] = [];
    await broker.subscribe(wanted, async (message) => {
      received.push(message);
    });

    await broker.publish(other, envelope(randomUUID()));
    await broker.publish(wanted, envelope(randomUUID()));

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
    // Exactly one: the message for the other topic must not have arrived here.
    expect(received).toHaveLength(1);
  });

  /**
   * A message the handler could not use is still acknowledged.
   *
   * Left unacknowledged it arrives again, and again — a malformed envelope will
   * be just as malformed on redelivery, so the retry is infinite and the
   * consumer never makes progress on anything else.
   */
  it('does not redeliver a message whose handler threw', async () => {
    const topic = `test.throw.${randomUUID().slice(0, 8)}`;
    const broker = await brokerFor([topic]);

    let attempts = 0;
    await broker.subscribe(topic, async () => {
      attempts += 1;
      throw new Error('deliberate');
    });

    await broker.publish(topic, envelope(randomUUID()));

    await vi.waitFor(() => expect(attempts).toBe(1), { timeout: 5_000 });
    // Given time to be redelivered, it must not be.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(attempts).toBe(1);
  });

  it('delivers several messages in order of publication', async () => {
    const topic = `test.order.${randomUUID().slice(0, 8)}`;
    const broker = await brokerFor([topic]);

    const received: string[] = [];
    await broker.subscribe(topic, async (message) => {
      received.push(String((message.payload as { n: number }).n));
    });

    for (let n = 0; n < 5; n += 1) {
      await broker.publish(topic, { tenantId: randomUUID(), correlationId: null, payload: { n } });
    }

    await vi.waitFor(() => expect(received).toHaveLength(5), { timeout: 8_000 });
    expect(received).toEqual(['0', '1', '2', '3', '4']);
  });
});

describe('the default broker', () => {
  /**
   * Unset `BROKER_URL` must select pg-boss, because that is the supported
   * deployment and the one that needs no extra container. A change that made
   * NATS the default would break every existing installation on upgrade.
   */
  it('is pg-boss when BROKER_URL is unset', async () => {
    const saved = process.env['BROKER_URL'];
    delete process.env['BROKER_URL'];

    try {
      // Constructed, not started: starting it would create the pgboss schema as
      // a side effect of a test that only asks which implementation was chosen.
      expect(createBroker().kind).toBe('pg-boss');
    } finally {
      if (saved) process.env['BROKER_URL'] = saved;
    }
  });
});
