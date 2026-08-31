/**
 * Subscribing to Web Push from the client (document 11 §7).
 *
 * ## Notification permission can only be asked for once
 *
 * The browser gives one chance. Once a user refuses, `requestPermission` will
 * never show its dialog again — changing it demands opening the site settings,
 * and nobody does that.
 *
 * So this whole file is arranged **not to burn that chance**: every condition
 * that would make a subscription certain to fail is checked FIRST, and
 * permission is only requested when subscribing can genuinely succeed.
 *
 * The most important of those is iOS. There, Web Push only works once the PWA
 * has been installed to the Home Screen; asking for permission before that
 * produces a permanent refusal from a user who was actually willing — and once
 * they have installed the PWA, that door is already closed.
 */

export type PushOutcome =
  | { ok: true; endpoint: string }
  | {
      ok: false;
      reason:
        | 'UNSUPPORTED'
        | 'NOT_CONFIGURED'
        | 'IOS_REQUIRES_INSTALL'
        | 'DENIED'
        | 'FAILED';
      message: string;
    };

function isIos(): boolean {
  // iPadOS 13+ reports itself as a Macintosh; `maxTouchPoints` is what
  // distinguishes it from a real Mac.
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // A Safari iOS-specific property, absent from the standard types.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Converts a base64url VAPID key into the form `subscribe()` accepts. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function subscribeToPush(
  api: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<PushOutcome> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED',
      message: 'Peramban ini tidak mendukung notifikasi.',
    };
  }

  // The server configuration is checked BEFORE permission is requested. An
  // installation with no VAPID key would fail to subscribe, and that failure must
  // not consume the one chance to ask.
  const info = await api('/api/notifications/subscriptions');
  if (!info.ok) {
    return { ok: false, reason: 'FAILED', message: 'Tidak dapat menghubungi server.' };
  }
  const { configured, publicKey } = (await info.json()) as {
    configured: boolean;
    publicKey: string | null;
  };
  if (!configured || !publicKey) {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message: 'Notifikasi belum diaktifkan pada sistem ini.',
    };
  }

  if (isIos() && !isStandalone()) {
    return {
      ok: false,
      reason: 'IOS_REQUIRES_INSTALL',
      message:
        'Di iPhone dan iPad, notifikasi hanya berfungsi setelah aplikasi ini ' +
        'dipasang ke Layar Utama. Buka menu Bagikan, lalu "Tambah ke Layar Utama".',
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'DENIED',
      message:
        'Izin notifikasi ditolak. Mengaktifkannya kembali harus lewat setelan situs di peramban.',
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // `subscribe()` returns the EXISTING subscription while it is alive, so
    // calling it repeatedly is safe — and the same endpoint is upserted by the
    // server rather than producing a second row.
    const subscription = await registration.pushManager.subscribe({
      // Required by the browser, and deliberately not fought: a silent push is the
      // ability to track a device's presence without its owner knowing.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const json = subscription.toJSON();
    const response = await api('/api/notifications/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent.slice(0, 300),
      }),
    });

    if (!response.ok) {
      return { ok: false, reason: 'FAILED', message: 'Langganan gagal disimpan.' };
    }

    return { ok: true, endpoint: subscription.endpoint };
  } catch {
    return { ok: false, reason: 'FAILED', message: 'Berlangganan notifikasi gagal.' };
  }
}

/**
 * Unsubscribes this device.
 *
 * Called at logout. Without it, a shared device keeps receiving the previous
 * user's notifications — their name, leave dates, and the decision appearing on
 * someone else's lock screen, with nobody noticing because no error appears
 * anywhere.
 */
export async function unsubscribeFromPush(
  api: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    // The server first, the browser second.
    //
    // The reverse order leaves a server row pointing at a dead endpoint: delivery
    // would fail with a 410 and the row would be dropped, but in between the
    // notification is still sent to a device whose user has logged out. The window
    // is short, and its contents are someone's name.
    await api('/api/notifications/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);

    await subscription.unsubscribe();
  } catch {
    // A failed unsubscribe must not block the logout. What is left behind is a
    // subscription the server will drop on its first failed delivery.
  }
}
