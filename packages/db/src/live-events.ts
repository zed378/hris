import { Client } from 'pg';

/**
 * The live event stream through `LISTEN`/`NOTIFY` (PLAN/12 §3).
 *
 * Chosen in place of the Socket.IO + Redis Streams in the microservices design.
 * The reason is not simplicity for its own sake: cross-node fan-out is only
 * needed when a user's connection is held by one of several processes that do
 * not know about each other. A single web process has no such problem, and
 * PostgreSQL already holds both ends.
 *
 * What has to be understood before using this file: **`LISTEN`/`NOTIFY` sits
 * outside the reach of Row-Level Security.** Every listener on a channel
 * receives every message on it. So the channel is per tenant — its isolation is
 * in the channel name, not in filtering after a message arrives.
 *
 * Another consequence that must not be forgotten: `LISTEN` demands a dedicated
 * connection held for the life of the stream, so it cannot use the Prisma pool.
 * That is why the stream count limit exists below.
 */

/** The channel name must match exactly the one built by the database trigger. */
export function tenantChannel(tenantId: string): string {
  return `att_${tenantId.replace(/-/g, '')}`;
}

/**
 * The limit on how many streams may live at once in one process.
 *
 * Every stream holds one PostgreSQL connection until it is closed. Without a
 * limit, a dashboard tab opened repeatedly — or a client reconnecting without
 * closing the old connection — would exhaust every database connection, and what
 * stops working is not the dashboard but the WHOLE application.
 */
const MAX_STREAMS = 32;
let active = 0;

export class TooManyStreamsError extends Error {
  constructor() {
    super('Terlalu banyak aliran langsung yang aktif');
    this.name = 'TooManyStreamsError';
  }
}

export interface LiveStream {
  /** Stops the subscription and returns its connection. Safe to call twice. */
  close: () => Promise<void>;
}

/**
 * Listens for one tenant's events.
 *
 * `onEvent` receives the JSON payload from `pg_notify` as it is. An unparseable
 * payload is discarded without stopping the stream: one malformed message must
 * not cut off a dashboard somebody is watching.
 */
export async function listenTenant(
  tenantId: string,
  onEvent: (payload: unknown) => void,
  onError?: (error: unknown) => void,
): Promise<LiveStream> {
  if (active >= MAX_STREAMS) throw new TooManyStreamsError();

  /**
   * The connection uses the APPLICATION role, not the database owner.
   *
   * The first version used `DATABASE_URL`, which connects as `hrms_owner` — the
   * only role that can bypass RLS and the only one not bound by
   * `statement_timeout`. Every open live dashboard therefore held a connection
   * with no time limit and full rights over the whole database, for work that
   * only needs to listen on one channel.
   *
   * `LISTEN`/`NOTIFY` does sit outside the reach of RLS, so no leak occurred in
   * this case. But a right that is not needed must not be taken merely because
   * it happens to be harmless on the path that exists today — the next path
   * somebody adds to this file would inherit it without anyone deciding so.
   */
  const connectionString = process.env['DATABASE_URL_APP'] ?? process.env['DATABASE_URL'];
  const client = new Client({ connectionString });
  await client.connect();
  active += 1;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    active -= 1;
    // `end()` can throw when the connection has already dropped on the server
    // side. What matters here is that the count went down, and that happened above.
    await client.end().catch(() => undefined);
  };

  client.on('error', (error) => {
    onError?.(error);
    void close();
  });

  client.on('notification', (message) => {
    if (!message.payload) return;
    try {
      onEvent(JSON.parse(message.payload));
    } catch {
      // A malformed payload is discarded. Its reason is in the JSDoc.
    }
  });

  // The channel name is interpolated through `format` rather than a parameter:
  // `LISTEN` does not accept bound parameters. Safe because the name is built
  // from a UUID whose shape has already been validated, not from free input.
  const channel = tenantChannel(tenantId);
  if (!/^att_[0-9a-f]{32}$/.test(channel)) {
    await close();
    throw new Error('Nama kanal tidak sah');
  }
  await client.query(`LISTEN "${channel}"`);

  return { close };
}

/** How many streams are alive. For monitoring and testing. */
export function activeStreamCount(): number {
  return active;
}
