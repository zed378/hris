'use client';

/**
 * The offline punch queue (document 11 §6).
 *
 * The only offline write in the system, and that is deliberate (P16). A leave
 * request can wait for signal; a person standing at the factory gate at seven in
 * the morning with no signal cannot.
 *
 * It does NOT use Background Sync. There is no support for it on iOS at all, and
 * building reliability on an API absent from half the user devices means
 * building reliability that only appears to work when tested on Android. What is
 * used instead are layered triggers: when connectivity returns, when the page
 * becomes visible again, and when the app is opened.
 *
 * The limit that has to be stated honestly (risk R48): iOS evicts the storage of
 * a site not opened for seven days. A queue that has built up over a week without
 * signal CAN BE LOST. `navigator.storage.persist()` reduces the risk, and the
 * user is told when that request is refused.
 */

const DB_NAME = 'hrms-offline';
const DB_VERSION = 1;
const STORE = 'punch-queue';

export interface QueuedPunch {
  /**
   * The owner of this punch — the id of the user who queued it.
   *
   * Mandatory, and its reason is a bug found while closing the Phase 3 DoD.
   *
   * The offline queue DELIBERATELY survives a logout: it belongs to the device,
   * not to the session, and clearing it would throw away the unsent punches of
   * whoever just logged out. That decision remains right.
   *
   * What was wrong is its consequence without an owner marker. The server
   * derived the `employeeId` from the SESSION, not from the punch contents. On a
   * shared device — a warehouse phone used across three shifts, a security post
   * computer — the sequence becomes:
   *
   *   1. A punches while the network is down. Their punch enters the queue.
   *   2. A logs out. The queue survives, by design.
   *   3. B logs in. The sync trigger runs.
   *   4. A's punch is sent with B's token, and recorded as B's attendance.
   *
   * A's attendance vanishes; B receives an attendance they did not perform. No
   * error appears, and both only become visible when the payslips are issued.
   */
  ownerUserId: string;
  /** Generated BEFORE the first send. The idempotency key on the server. */
  dedupeKey: string;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';
  punchedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  photoKey: string | null;
  deviceInfo: string | null;
  queuedAt: string;
  attempts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'dedupeKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function enqueuePunch(punch: QueuedPunch): Promise<void> {
  await withStore('readwrite', (store) => store.put(punch));
}

export async function queuedPunches(): Promise<QueuedPunch[]> {
  return withStore('readonly', (store) => store.getAll() as IDBRequest<QueuedPunch[]>);
}

export async function dequeuePunch(dedupeKey: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(dedupeKey));
}

export interface FlushResult {
  sent: number;
  failed: number;
  /** The current user's punches still held. */
  remaining: number;
  /** Punches belonging to another user on the same device. */
  otherUsers: number;
}

/**
 * Sends the whole queue.
 *
 * A punch the server refuses with a permanent error (4xx other than 401/429) is
 * dropped from the queue. Keeping it forever means a queue that is never empty
 * and an "unsent" indicator that never clears — so the user stops trusting it.
 * berhenti memercayainya.
 * Safe to run twice at once: the server uses `dedupeKey` as a unique key, so a
 * double send produces one row and a success response.
 */
export async function flushQueue(
  send: (punch: QueuedPunch) => Promise<Response>,
  /**
   * The user currently logged in. Only their punches are sent.
   *
   * Another person's punches are LEFT in the queue rather than discarded: their
   * owner may log in again later on the same device, and their attendance can
   * still be sent. Discarding them would erase someone's attendance because
   * another person happened to use the device first.
   */
  currentUserId: string,
): Promise<FlushResult> {
  const queue = await queuedPunches();
  let sent = 0;
  let failed = 0;

  for (const punch of queue) {
    // Someone else's — skipped silently, and not counted as a failure. It is not
    // a failure; it is simply not this punch's turn.
    if (punch.ownerUserId !== currentUserId) continue;

    try {
      const response = await send(punch);

      if (response.ok) {
        await dequeuePunch(punch.dedupeKey);
        sent += 1;
        continue;
      }

      // 401 and 429 are temporary: a session can be refreshed, a rate limit will
      // ease. The punch stays in the queue.
      if (response.status === 401 || response.status === 429 || response.status >= 500) {
        failed += 1;
        await enqueuePunch({ ...punch, attempts: punch.attempts + 1 });
        continue;
      }

      // The rest are permanent — data the server will never accept.
      await dequeuePunch(punch.dedupeKey);
      failed += 1;
    } catch {
      // The network is still down. Leave it in the queue.
      failed += 1;
    }
  }

  const remainingAll = await queuedPunches();

  return {
    sent,
    failed,
    // Only the current user's are counted. An "3 unsent" indicator that actually
    // belongs to the previous shift's colleague would make someone wait for
    // something that will never be sent for them.
    remaining: remainingAll.filter((punch) => punch.ownerUserId === currentUserId).length,
    /** Belonging to another user on this device. Shown separately, not hidden. */
    otherUsers: remainingAll.filter((punch) => punch.ownerUserId !== currentUserId).length,
  };
}

/**
 * Requests persistent storage.
 *
 * Returns false when the browser refuses — and that is not an error but
 * information that has to be passed on to the user. On iOS, a refusal means the
 * queue can be lost after seven days without being opened.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
