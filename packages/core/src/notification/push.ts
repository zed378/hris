import webpush from 'web-push';
import { log } from '@hrms/observability';
import { type TenantClient } from '@hrms/db';

/**
 * Web Push (document 11 §7).
 *
 * `NotificationChannel.WEB_PUSH` has been in the enum since the notification
 * module was built, with not one producer. This file is what fills it.
 *
 * ## Push is NEVER the only path
 *
 * Document 04 §R52 names it a high risk, and the reason is not network
 * fragility: **Web Push does not work on iOS unless the PWA has been installed
 * to the Home Screen.** Most users will not install it, and for them a push that
 * was "delivered" never appears anywhere.
 *
 * So its shape here is an **addition, not a replacement**. Email is still sent
 * for anything important; push only makes it arrive faster for those whose
 * device supports it. Replacing email with push means moving the news "your leave
 * was refused" onto a channel that silently fails to arrive for half the users.
 *
 * ## A failure is treated as a fact, not an error
 *
 * A push subscription dies without telling anyone: the user clears their
 * browser, revokes the permission, or replaces the device. The push service
 * answers 404/410 for an endpoint that is no longer valid, and that answer is
 * **not a problem worth recording as a failure** — it is information that the
 * row deserves deleting. Treating it as an error would fill the logs with events
 * nobody can act on.
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null | undefined;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other rather than stacking. */
  tag: string;
  /** Opened when the notification is clicked. */
  url: string;
}

/**
 * The VAPID keys, read once.
 *
 * Their absence is **not an error** — it means push is not configured, and the
 * system has to keep working without it. Throwing here would bring down all
 * notification delivery just because one optional channel is unset.
 * disetel.
 */
function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env['VAPID_PUBLIC_KEY'];
  const privateKey = process.env['VAPID_PRIVATE_KEY'];
  const subject = process.env['VAPID_SUBJECT'] ?? 'mailto:admin@localhost';

  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export function pushConfigured(): boolean {
  return vapid() !== null;
}

/** The public key for the client. Safe to share — it has to be. */
export function pushPublicKey(): string | null {
  return vapid()?.publicKey ?? null;
}

export async function saveSubscription(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  input: PushSubscriptionInput,
): Promise<{ id: string }> {
  // An upsert on the endpoint, not a create. The browser returns the SAME
  // endpoint while its subscription is alive, and `subscribe()` is called every
  // time the app loads — a create would fail on the second load.
  //
  // Its owner is updated too: one shared device changing hands must send
  // notifications to whoever is using it now, not to yesterday's user. This is
  // the same class as the offline punch queue, and here the answer differs
  // because a push subscription genuinely belongs to a browser session rather
  // than to the device.
  const row = await tx.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      tenantId,
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
    update: {
      tenantId,
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      failureCount: 0,
    },
    select: { id: true },
  });

  return row;
}

export async function removeSubscription(
  tx: TenantClient,
  tenantId: string,
  endpoint: string,
): Promise<boolean> {
  const removed = await tx.pushSubscription.deleteMany({ where: { tenantId, endpoint } });
  return removed.count > 0;
}

/** Deletes all of a user's subscriptions. Used at logout. */
export async function removeUserSubscriptions(
  tx: TenantClient,
  tenantId: string,
  userId: string,
): Promise<number> {
  const removed = await tx.pushSubscription.deleteMany({ where: { tenantId, userId } });
  return removed.count;
}

export interface PushResult {
  sent: number;
  /** Dead subscriptions removed. Not a failure. */
  pruned: number;
  failed: number;
}

/**
 * Sends one notification to all of a user's devices.
 *
 * Returns `sent: 0` when push is not configured or the user has no subscription.
 * Both are normal states, not failures.
 */
export async function sendPush(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  payload: PushPayload,
): Promise<PushResult> {
  const keys = vapid();
  const result: PushResult = { sent: 0, pruned: 0, failed: 0 };
  if (!keys) return result;

  const subscriptions = await tx.pushSubscription.findMany({
    where: { tenantId, userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return result;

  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const body = JSON.stringify(payload);

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        body,
        // TTL: a leave notification arriving three days later is useless. The push
        // service stores it this long while the device is switched off.
        { TTL: 12 * 3600 },
      );

      await tx.pushSubscription.update({
        where: { id: subscription.id },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      });
      result.sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      // 404/410 means the endpoint is no longer valid — the user cleared their
      // browser, revoked the permission, or replaced the device. Its row is
      // deleted, and that is NOT a failure: recording it as an error would fill
      // the logs with events nobody can act on.
      if (status === 404 || status === 410) {
        await tx.pushSubscription.delete({ where: { id: subscription.id } });
        result.pruned += 1;
        continue;
      }

      // The rest are counted, and a subscription that fails repeatedly is dropped.
      // Without this limit, a quietly broken endpoint would be retried forever.
      const failed = await tx.pushSubscription.update({
        where: { id: subscription.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });
      if (failed.failureCount >= 10) {
        await tx.pushSubscription.delete({ where: { id: subscription.id } });
        result.pruned += 1;
      }

      result.failed += 1;
      log.warn({ scope: 'push', tenantId, userId, status, error });
    }
  }

  return result;
}
