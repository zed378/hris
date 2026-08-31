# 11 — Progressive Web App (PWA)

---

## 1. The Decision & Its Scope

### 1.1 Which Application Becomes a PWA

| Application | PWA? | Reason |
|-------------|:----:|--------|
| `app.hrms.id` — the tenant application | ✅ Yes | Used by HR and employees every day, often from a phone, often on an unstable network |
| `admin.hrms.id` — the global dashboard | ❌ **No** | A control plane with the strictest CSP, 8-hour sessions, and an IP allowlist. A service worker adds attack surface with no benefit: a superuser needs no offline mode |

The decision about `admin.hrms.id` is not an oversight. Document `07` §7 separates the control plane physically precisely so a harder security policy can be applied. Adding a service worker — code that runs outside the page lifecycle and can intercept every network request — works against that goal.

### 1.2 What Works Offline

Deciding this up front prevents both user disappointment and wasted work.

| Capability | Offline | Note |
|------------|:-------:|------|
| Opening the app, navigation, the UI shell | ✅ | The app shell is cached |
| Viewing your own profile, shift schedule, leave balance | ✅ | Personal data, cached with a short TTL |
| **Punching in** | ✅ | Queued locally, sent when online (§6) |
| Requesting leave | ✅ | Queued locally; needs server balance validation on sync |
| Viewing 30 days of attendance history | ✅ | Cached |
| Viewing a payslip | ❌ | **Deliberately not cached** — see §5.4 |
| The tenant / team dashboard | ❌ | Company-wide aggregate data; stale here is dangerous, not merely useless |
| Approving leave, running payroll, managing employees | ❌ | Operations that need concurrency and up-to-date authorisation |

**The principle applied:** offline is granted for **reading your own data** and for **one kind of write that is genuinely blocked by the network** (punching in). Everything else shows a clear status rather than failing silently.

---

## 2. The Real Limits of a PWA for This Case

This section comes first because it determines the decisions in §3.

### 2.1 The Platform Support Table

| Capability | Chrome / Android | Safari / iOS 17+ | Effect on the product |
|------------|:----------------:|:----------------:|-----------------------|
| Install to the home screen | ✅ Automatic (prompt) | ⚠️ Manual via Share → Add to Home Screen | Lower iOS adoption; an in-app guide is needed |
| Service worker & cache | ✅ | ✅ | — |
| Camera (`getUserMedia`) | ✅ | ✅ | Photo punching works |
| Geolocation | ✅ | ✅ | Coordinates are captured |
| **Mock GPS detection** | ❌ | ❌ | **The trust score weakens significantly (§2.2)** |
| Background Sync API | ✅ | ❌ | The offline queue only sends when the app is open |
| Periodic Background Sync | ✅ | ❌ | Not used at all |
| Web Push | ✅ | ⚠️ Only once the PWA is installed | iOS notifications are unreliable for users who do not install |
| Persistent storage | ✅ (`navigator.storage.persist()`) | ⚠️ Limited | **Data is evicted after 7 unused days if not installed** |
| Rooted device detection | ❌ | ❌ | The `ROOTED_DEVICE` signal is unavailable on the web |

### 2.2 The Biggest Consequence: Attendance Evidence Is Weaker

Document `10` §5 builds a trust score from several signals. Three of them are **entirely unavailable on the web**:

| Signal | Native | Web |
|--------|:------:|:---:|
| `isFromMockProvider` | ✅ | ❌ No API for it |
| Root/jailbreak detection | ✅ | ❌ |
| Wi-Fi SSID | ✅ | ❌ Not exposed to JavaScript |

On the web, faking a location is even easier than on Android: open DevTools → Sensors → set the coordinates. Nothing needs installing.

**The mandatory adjustment:**

```typescript
// services/attendance-service/src/domain/trust-scoring.ts (addition)
export function scorePunch(ctx: PunchContext): TrustAssessment {
  let score = 100;
  const flags: string[] = [];

  // A browser punch is scored from a lower base, not by the same rules.
  // The absence of a MOCK_LOCATION flag on the web does not mean the location
  // is genuine — it only means we could not check.
  if (ctx.source === 'WEB') {
    score -= 20;
    flags.push('WEB_UNVERIFIED_DEVICE');
    // Compensation: office network IP verification means far more on the web
    if (ctx.ipMatchesSiteRange) { score += 25; flags.push('OFFICE_IP_VERIFIED'); }
  }
  // ... the rest of the assessment as in document 10 §5.1
}
```

For tenants who demand certainty, the `FALLBACK_ONLY` policy (web punching only from an office IP) becomes a sensible choice — and it already exists in `attendance_policies`.

### 2.3 The Second Consequence: an iOS Offline Queue Can Vanish

Safari evicts site storage after **7 days without interaction** for a PWA that has not been installed to the home screen. Offline punches stored in IndexedDB can disappear before they are ever sent.

Layered mitigation:

```typescript
// apps/web/src/lib/offline/storage-guard.ts
export async function ensureDurableStorage(): Promise<StorageStatus> {
  if (!navigator.storage?.persist) return { persistent: false, reason: 'UNSUPPORTED' };

  const already = await navigator.storage.persisted();
  if (already) return { persistent: true };

  // Chrome grants it automatically when the PWA is installed and used often.
  // Safari ignores this request entirely.
  const granted = await navigator.storage.persist();
  return { persistent: granted, reason: granted ? undefined : 'DENIED_BY_BROWSER' };
}

// If storage is not guaranteed AND there is a queue waiting,
// the user has to know — not be given a false sense of security.
export function OfflineQueueBanner() {
  const { pending, storageStatus } = useOfflineQueue();
  if (pending === 0) return null;

  if (!storageStatus.persistent && isIos()) {
    return (
      <Banner tone="warning">
        {pending} presensi menunggu dikirim. Buka aplikasi ini saat ada koneksi
        dalam 7 hari agar data tidak hilang.
        {!isInstalled() && <InstallHint>Pasang ke Layar Utama agar lebih aman</InstallHint>}
      </Banner>
    );
  }
  return <Banner tone="info">{pending} presensi menunggu dikirim.</Banner>;
}
```

### 2.4 The Recommendation: PWA First, Native for Specific Cases

| User segment | Recommendation |
|--------------|----------------|
| HR & admins (mostly desktop use) | **PWA only.** Native adds nothing |
| Office employees at a fixed location | **The PWA is enough.** Punching from an office IP already gives adequate certainty |
| Field workers, sales, project staff | **Native is still needed** — a reliable offline queue, mock GPS detection, push notifications |
| Tenants with strict compliance needs (manufacturing, construction) | Native, or an on-site attendance machine |

**Roadmap effect:** the PWA is built in Phase 1 and **replaces most of what was originally planned for ESS Mobile in Phase 3**. The React Native app is still built, but its scope narrows to the cases that genuinely need native capabilities — so the estimate falls rather than rises (§9).

---

## 3. PWA Architecture

```mermaid
graph TB
    subgraph Browser
        UI[Next.js App Shell<br/>React 19]
        SW[Service Worker<br/>Workbox]
        IDB[(IndexedDB<br/>queue & personal data)]
        CS[(Cache Storage<br/>assets & shell)]
    end

    subgraph Network
        CDN[CDN / Cloudflare]
        GW[api-gateway]
    end

    UI -->|fetch| SW
    SW -->|cache hit| CS
    SW -->|cache miss / mutation| CDN
    CDN --> GW
    SW <--> IDB
    UI <-->|queue status, conflicts| IDB

    SW -.push event.-> UI
    GW -.Web Push.-> SW
```

### 3.1 The Manifest

```json
// apps/web/public/manifest.webmanifest
{
  "id": "/?source=pwa",
  "name": "HR Management Suite",
  "short_name": "HRMS",
  "description": "Presensi, cuti, slip gaji, dan administrasi HR",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone", "browser"],
  "orientation": "portrait-primary",
  "background_color": "#ffffff",
  "theme_color": "#0f172a",
  "lang": "id-ID",
  "dir": "ltr",
  "categories": ["business", "productivity"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Presensi", "short_name": "Presensi", "url": "/attendance/punch?source=shortcut",
      "icons": [{ "src": "/icons/shortcut-punch.png", "sizes": "96x96" }] },
    { "name": "Ajukan Cuti", "short_name": "Cuti", "url": "/leave/new?source=shortcut",
      "icons": [{ "src": "/icons/shortcut-leave.png", "sizes": "96x96" }] },
    { "name": "Slip Gaji", "short_name": "Slip", "url": "/payroll/payslips?source=shortcut",
      "icons": [{ "src": "/icons/shortcut-payslip.png", "sizes": "96x96" }] }
  ],
  "screenshots": [
    { "src": "/screenshots/mobile-dashboard.png", "sizes": "390x844", "type": "image/png",
      "form_factor": "narrow" },
    { "src": "/screenshots/desktop-dashboard.png", "sizes": "1280x800", "type": "image/png",
      "form_factor": "wide" }
  ],
  "prefer_related_applications": false
}
```

> `shortcuts` puts the punch button one tap from the home screen — a shortcut that directly addresses the most common complaint about attendance apps: too many steps when you are in a hurry in the morning.

### 3.2 The Caching Strategy

```typescript
// apps/web/src/sw.ts — built with Workbox
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { BackgroundSyncPlugin } from 'workbox-background-sync';

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);          // hashed build assets

// ── 1. Hashed static assets: their contents never change ──
registerRoute(
  ({ request, url }) => url.pathname.startsWith('/_next/static/'),
  new CacheFirst({
    cacheName: 'static-assets-v1',
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
);

// ── 2. Fonts & icons ──
registerRoute(
  ({ request }) => ['font', 'image'].includes(request.destination),
  new CacheFirst({
    cacheName: 'media-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

// ── 3. Navigation: the app shell ──
registerRoute(new NavigationRoute(
  new NetworkFirst({
    cacheName: 'pages-v1',
    networkTimeoutSeconds: 3,                  // a slow network → fall straight back to the cache
    plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 })],
  }),
  { denylist: [/^\/api\//, /^\/auth\//] },
));

// ── 4. Personal data that may be briefly stale ──
const PERSONAL_CACHEABLE = [
  '/api/me/bootstrap',
  '/api/attendance/me/summary',
  '/api/attendance/me/schedule',
  '/api/leave/me/balance',
  '/api/employees/me',
];
registerRoute(
  ({ url }) => PERSONAL_CACHEABLE.some((p) => url.pathname.startsWith(p)),
  new NetworkFirst({
    cacheName: 'api-personal-v1',
    networkTimeoutSeconds: 4,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 60 * 60 * 12 }),
      tenantScopePlugin,                        // §5.2 — cache keys separated per tenant and user
    ],
  }),
);

// ── 5. What is NEVER cached ──
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/payroll/') ||       // salary data (§5.4)
    url.pathname.startsWith('/api/dashboard/') ||     // aggregates; stale is misleading
    url.pathname.startsWith('/api/relation/') ||      // confidential cases
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/api/iam/'),
  new NetworkOnly(),
);

// ── 6. Mutations: the background queue (Chromium) ──
const punchQueue = new BackgroundSyncPlugin('punch-queue', {
  maxRetentionTime: 7 * 24 * 60,               // minutes
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try {
        await fetch(entry.request.clone());
        await notifyClients({ type: 'PUNCH_SYNCED' });
      } catch (err) {
        await queue.unshiftRequest(entry);      // put it back on the queue, retry later
        throw err;
      }
    }
  },
});

registerRoute(
  ({ url, request }) => url.pathname === '/api/attendance/punch' && request.method === 'POST',
  new NetworkOnly({ plugins: [punchQueue] }),
  'POST',
);

// ── 7. The offline fallback ──
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('pages-v1').then((c) => c.addAll(['/offline'])));
});
```

> **An important note on `BackgroundSyncPlugin`:** it works only in Chromium. Safari fails silently. That is why the queue in §6 **does not depend on it** — Background Sync is an accelerant, not the primary mechanism.

---

## 4. Application Updates

### 4.1 A Problem Peculiar to Microservices

A service worker serves a cached bundle. If `api-gateway` and the backend services are already on a new version while the browser still runs the old bundle, the API contract can mismatch — and the user sees an error that makes no sense.

This is not hypothetical: with per-service deploys (document `01` §8.1), the backend changes more often than the frontend.

### 4.2 The Solution: Version Negotiation + a Controlled Update

```typescript
// apps/web/src/lib/pwa/update-manager.ts
export function useAppUpdate() {
  const [state, setState] = useState<'idle' | 'available' | 'required'>('idle');

  useEffect(() => {
    // 1. A new service worker was detected
    navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            setState('available');
          }
        });
      });
      // Check every 30 minutes and every time the tab becomes active again
      setInterval(() => reg.update(), 30 * 60_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update();
      });
    });

    // 2. The backend signals that this client version is too old.
    //    The gateway includes an X-Min-Client-Version header on every response.
    api.interceptors.response.use((res) => {
      const min = res.headers['x-min-client-version'];
      if (min && semverLt(APP_VERSION, min)) setState('required');
      return res;
    });
  }, []);

  const applyUpdate = async () => {
    const reg = await navigator.serviceWorker.ready;
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    // Reload once the controller has changed
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  };

  return { state, applyUpdate };
}
```

```tsx
// An optional update: offer it, do not force it — the user may be filling in a form
{state === 'available' && (
  <Toast action={{ label: 'Muat ulang', onClick: applyUpdate }}>
    Versi baru tersedia.
  </Toast>
)}

// A required update: explain, then force it
{state === 'required' && (
  <BlockingDialog title="Pembaruan diperlukan"
    description="Versi aplikasi Anda tidak lagi kompatibel dengan server. Muat ulang untuk melanjutkan."
    action={{ label: 'Muat ulang sekarang', onClick: applyUpdate }} />
)}
```

> **`skipWaiting()` is never called automatically.** Swapping the service worker mid-session can replace the JavaScript bundle while the user is filling in a leave form, and a lazily loaded old chunk may no longer be found. An update is applied only on a user action, or when the backend declares the old version unsupported.

### 4.3 Contract Compatibility

The same rules as non-destructive migration (document `09`) apply to the API the PWA client consumes:

```typescript
// services/api-gateway/src/middleware/client-version.middleware.ts
const MIN_SUPPORTED_CLIENT = '2.0.0';       // raised only when there is a breaking change

res.header('X-Min-Client-Version', MIN_SUPPORTED_CLIENT);
res.header('X-Server-Version', APP_VERSION);
```

Because API changes are additive, `MIN_SUPPORTED_CLIENT` is rarely raised. If it ever is, that signals a breaking change — and it is worth reviewing whether it was really necessary.

---

## 5. Security & Multitenancy

### 5.1 A Service Worker Is Privileged Code

A service worker intercepts every network request in its scope and survives after the tab is closed. Therefore:

| Rule | Reason |
|------|--------|
| Served from the same origin, scope `/` | Never from a third-party CDN |
| `Service-Worker-Allowed` is not widened | The scope stays under the application's control |
| A strict CSP on the SW file | Prevents injection |
| Never store an access token in Cache Storage or IndexedDB | §5.3 |
| The SW version is published with an integrity hash | Detects unauthorised change |

```nginx
location /sw.js {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    add_header Content-Security-Policy "default-src 'none'; connect-src 'self'";
    # The SW must not be cached: if it is, an update can be held back for days
}
```

### 5.2 Caches Separated per Tenant and per User

This is a real problem on a shared device — an attendance tablet in a factory, or a shared computer in a branch office.

```typescript
// apps/web/src/lib/pwa/tenant-scope-plugin.ts
export const tenantScopePlugin: WorkboxPlugin = {
  // The cache key is stamped with the tenantId and userId. Two different users
  // on the same device never share a cache entry.
  cacheKeyWillBeUsed: async ({ request }) => {
    const session = await getSessionMeta();      // from IndexedDB, not the token
    if (!session) return request;
    const url = new URL(request.url);
    url.searchParams.set('__t', session.tenantId);
    url.searchParams.set('__u', session.userId);
    return new Request(url.toString(), request);
  },
};
```

```typescript
// A full wipe on logout or a tenant switch
export async function purgeAllClientData(reason: 'LOGOUT' | 'TENANT_SWITCH' | 'SESSION_REVOKED') {
  // 1. All of Cache Storage
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));

  // 2. IndexedDB — EXCEPT the punch queue that has not been sent.
  //    Deleting an unsynced punch means erasing an attendance that
  //    genuinely happened.
  await idb.clearAllExcept(['pendingPunches']);

  // 3. Tell the service worker
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: 'PURGE_CACHES', reason });

  // 4. Unsubscribe from push so notifications do not reach the next person
  const sub = await reg.pushManager.getSubscription();
  await sub?.unsubscribe();
}
```

> The `pendingPunches` exception is deliberate and must be explained to the user: if a punch has not been sent at logout time, the app shows a warning and offers to send it first.

### 5.3 Tokens Never Touch Persistent Storage

```
Access token   → an in-memory variable only. Lost when the tab closes — as it should be
Refresh token  → an HttpOnly + Secure + SameSite=Strict cookie. JavaScript cannot read it
Session metadata → IndexedDB, only { tenantId, userId, expiresAt }. No credentials
```

The service worker never adds an `Authorization` header of its own. It forwards requests as they are; the token is injected by the application layer. This stops a compromised service worker from making authenticated requests on the user's behalf.

### 5.4 Why Payslips Are Not Cached

A conscious choice that trades convenience for a clear reason:

- A payslip is the most sensitive data an ordinary employee can reach.
- A PWA is often installed on a shared device.
- Cache Storage can be read by anyone holding an unlocked device.
- Its offline value is low — a payslip is opened once a month, almost always with a connection.

A payslip PDF can still be **downloaded** explicitly by the user; the difference is that this is a conscious user decision and it lands in device file storage, which is subject to operating system controls.

---

## 6. The Offline Queue

### 6.1 It Does Not Depend on Background Sync

Because Safari does not support it, the primary mechanism is IndexedDB plus layered sync triggers.

```typescript
// apps/web/src/lib/offline/punch-queue.ts
const db = await openDB('hrms-offline', 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const store = db.createObjectStore('pendingPunches', { keyPath: 'localId' });
      store.createIndex('by-status', 'status');
      store.createIndex('by-captured', 'capturedAt');
    }
    if (oldVersion < 2) {
      db.createObjectStore('pendingLeaveRequests', { keyPath: 'localId' });
    }
  },
});

export async function enqueuePunch(evidence: PunchEvidence) {
  const entry = {
    localId: uuidv7(),
    ...evidence,
    capturedOffline: true,
    status: 'PENDING' as const,
    attempts: 0,
    queuedAt: new Date().toISOString(),
  };
  await db.put('pendingPunches', entry);

  // The photo is stored as a separate Blob — IndexedDB handles that efficiently;
  // storing base64 would inflate the size by ~33%
  await db.put('pendingPhotos', { localId: entry.localId, blob: evidence.photoBlob });

  await requestBackgroundSyncIfAvailable('punch-queue');   // a Chromium accelerant
  return entry.localId;
}

export async function flushQueue() {
  const pending = await db.getAllFromIndex('pendingPunches', 'by-status', 'PENDING');

  for (const entry of pending) {
    try {
      const photo = await db.get('pendingPhotos', entry.localId);
      const { fileId } = await uploadPhoto(photo.blob);

      await api.post('/attendance/punch', {
        ...entry,
        photoFileId: fileId,
        syncedAt: new Date().toISOString(),
      }, {
        // The server's dedupe_key plus an idempotency key: safe even if the flush runs twice
        headers: { 'Idempotency-Key': entry.localId },
      });

      await db.delete('pendingPunches', entry.localId);
      await db.delete('pendingPhotos', entry.localId);
    } catch (err) {
      if (isNetworkError(err)) return;                  // stop; try again later
      // A non-network error (for instance the server rejecting the punch) must not
      // leave the entry stuck in the queue forever
      await db.put('pendingPunches', {
        ...entry, status: 'FAILED', attempts: entry.attempts + 1,
        lastError: serializeError(err),
      });
    }
  }
}

// Layered triggers — only one has to succeed
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });
setInterval(() => { if (navigator.onLine) flushQueue(); }, 60_000);
navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type === 'PUNCH_SYNCED') queryClient.invalidateQueries(['attendance']);
});
```

### 6.2 Honest Feedback

The interface must not present an offline punch as though it were already recorded on the server.

```tsx
<PunchResult status={result.status}>
  {result.status === 'SYNCED' && <>✓ Presensi tercatat pukul {time}</>}
  {result.status === 'QUEUED' && (
    <>
      ⏳ Presensi tersimpan di perangkat pukul {time}
      <Detail>Akan dikirim otomatis saat ada koneksi.</Detail>
      {isIos() && !isPersistent && (
        <Warning>Buka aplikasi dalam 7 hari agar data tidak terhapus browser.</Warning>
      )}
    </>
  )}
  {result.status === 'FAILED' && (
    <>⚠ Presensi tidak dapat dikirim. <Action onClick={retry}>Coba lagi</Action></>
  )}
</PunchResult>
```

---

## 7. Web Push

```typescript
// apps/web/src/lib/pwa/push.ts
export async function subscribeToPush(): Promise<PushSubscriptionResult> {
  if (!('PushManager' in window)) return { ok: false, reason: 'UNSUPPORTED' };

  // iOS: Web Push works ONLY once the PWA has been installed to the Home Screen.
  // Asking for permission before that fails and burns the one chance to ask.
  if (isIos() && !isStandalone()) {
    return { ok: false, reason: 'IOS_REQUIRES_INSTALL', showInstallGuide: true };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'DENIED' };

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,                    // required; silent push is not allowed
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  await api.post('/notifications/subscriptions', {
    endpoint: sub.endpoint,
    keys: sub.toJSON().keys,
    userAgent: navigator.userAgent,
  });
  return { ok: true };
}
```

```typescript
// sw.ts — push handling
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag,                            // notifications of the same kind replace each other
    renotify: false,
    data: { url: data.url },
    actions: data.actions,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focus an already-open tab rather than opening a new one
      const existing = list.find((c) => c.url.includes(new URL(url, location.origin).pathname));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    }),
  );
});
```

**Because Web Push is unreliable on iOS**, `notification-service` keeps a tiered path:

```
Web push  →  fails/unavailable  →  Native push (if the app is installed)
          →  fails              →  Email
          →  for anything urgent →  WhatsApp
```

---

## 8. Performance

The target market connects over Indonesian mobile networks, often on weak 4G. The performance budget is set as a CI gate, not an aspiration.

| Metric | Budget | Test device |
|--------|--------|-------------|
| Largest Contentful Paint | < 2.5 s | Moto G Power, slow 4G throttling |
| Interaction to Next Paint | < 200 ms | as above |
| Cumulative Layout Shift | < 0.1 | as above |
| Initial JS bundle (gzip) | < 180 KB | — |
| Per-module bundle (gzip) | < 120 KB | — |
| Precache size | < 3 MB | — |
| Lighthouse PWA | 100 | — |
| Lighthouse Performance | ≥ 90 | — |

```yaml
# .github/workflows/pwa-budget.yml
- name: Lighthouse CI
  run: |
    pnpm build
    pnpm lhci autorun --collect.settings.preset=mobile
  env:
    LHCI_BUDGET: |
      [{ "path": "/*",
         "resourceSizes": [
           { "resourceType": "script", "budget": 180 },
           { "resourceType": "total",  "budget": 800 }],
         "timings": [
           { "metric": "largest-contentful-paint", "budget": 2500 },
           { "metric": "cumulative-layout-shift",  "budget": 0.1 }] }]
```

Per-module bundle loading follows the subscription (document `01` §5.5): a Basic plan customer never downloads the Recruitment code, which keeps this budget realistic even as the module count grows.

---

## 9. Roadmap Impact

### 9.1 The Change in ESS Mobile Scope

| | Original plan | After the PWA |
|---|---|---|
| Phase 1 | — | **A full PWA**: installation, offline, push, web punching |
| Phase 3 | A complete React Native ESS (± 12 pm) | **A limited React Native ESS** (± 7 pm): only the capabilities the web lacks — a reliable offline queue, mock GPS and root detection, dependable iOS push, the native camera |
| Difference | | **− 5 pm** in Phase 3, **+ 4 pm** in Phase 1 |

**Net: − 1 person-month**, with far wider user reach from Phase 1 onwards. This is one of the few scope changes in this blueprint that lowers cost and raises value at the same time — because the PWA replaces work that was already planned rather than adding new work.

### 9.2 Placement

**Phase 1, Sprints 3–4 (alongside the frontend shell):**
- The manifest, icons, a basic service worker, the caching strategy
- Cache separation per tenant and user, the wipe on logout
- The controlled update flow + client version negotiation
- The performance budget as a CI gate

**Phase 1, Sprints 6–9 (alongside `attendance-service`):**
- The offline punch queue (IndexedDB)
- The trust score adjustment for the `WEB` source
- The iOS-specific installation guide
- The storage durability warning

**Phase 2:**
- Web Push + subscriptions; the tiered path in `notification-service`
- App shortcuts, the share screen

**Phase 3:**
- The React Native ESS with its narrowed scope

---

## 10. Testing

```typescript
// test/pwa/service-worker.spec.ts
describe('Service worker', () => {
  it('never caches a payroll endpoint', async () => {
    await page.goto('/payroll/payslips');
    await page.waitForResponse((r) => r.url().includes('/api/payroll/payslips'));
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      for (const n of names) {
        const c = await caches.open(n);
        const keys = await c.keys();
        if (keys.some((k) => k.url.includes('/api/payroll/'))) return true;
      }
      return false;
    });
    expect(cached).toBe(false);
  });

  it('wipes every cache on logout', async () => {
    await login('acme', 'hr@acme.id');
    await page.goto('/attendance');
    await logout();
    const remaining = await page.evaluate(() => caches.keys());
    expect(remaining).toEqual([]);
  });

  it('user A cache is not readable by user B on the same device', async () => {
    await login('acme', 'a@acme.id');
    await page.goto('/employees/me');
    await logout();
    await login('acme', 'b@acme.id');
    const leaked = await page.evaluate(() =>
      fetch('/api/employees/me').then((r) => r.json()).then((d) => d.email));
    expect(leaked).toBe('b@acme.id');
  });

  it('never stores a token in Cache Storage or IndexedDB', async () => {
    await login('acme', 'hr@acme.id');
    const found = await page.evaluate(async () => {
      const dump = JSON.stringify(await dumpAllClientStorage());
      return /eyJhbGciOi|Bearer /.test(dump);        // the JWT pattern
    });
    expect(found).toBe(false);
  });
});

// test/pwa/offline.spec.ts
describe('Offline mode', () => {
  it('stores a punch offline and sends it once online', async () => {
    await login('acme', 'budi@acme.id');
    await page.context().setOffline(true);
    await submitPunch();
    await expect(page.getByText('tersimpan di perangkat')).toBeVisible();

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Presensi tercatat')).toBeVisible({ timeout: 10_000 });

    const punches = await api.get('/attendance/me/summary');
    expect(punches.data.today).toHaveLength(1);      // exactly one, not a duplicate
  });

  it('flushing twice produces no duplicate punch', async () => {
    await queueOfflinePunch();
    await page.evaluate(() => Promise.all([flushQueue(), flushQueue()]));
    const punches = await api.get('/attendance/me/summary');
    expect(punches.data.today).toHaveLength(1);      // dedupe_key + Idempotency-Key
  });

  it('the payroll page shows an offline status rather than stale data', async () => {
    await page.goto('/payroll/payslips');
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.getByText('Tidak tersedia saat luring')).toBeVisible();
  });
});
```

The tests run on **both Chromium and WebKit** in Playwright. WebKit is mandatory because Safari's behaviour differs precisely in the riskiest places.

---

## 11. Risks

| # | Risk | Prob. | Impact | Mitigation |
|---|------|-------|--------|------------|
| **R47** | **Web punching is assumed as strong as native even though mock GPS goes undetected** | **High** | High | An automatic `WEB_UNVERIFIED_DEVICE` flag, a lower score, office IP verification as compensation, the `FALLBACK_ONLY` policy available; stated explicitly in the sales material |
| **R48** | **The offline punch queue is lost on iOS because of 7-day storage eviction** | Medium | High | `navigator.storage.persist()`, an explicit warning to the user, a nudge to install to the Home Screen, a 7-day queue limit matching the server policy |
| R49 | A stale service worker serves a bundle incompatible with the new API | Medium | Medium | The `X-Min-Client-Version` header, a controlled forced update, and additive APIs that make it rare |
| R50 | One user's data is read by another on a shared device | Low | **Critical** | Cache keys per tenant and user, a full wipe on logout, a leak test as a CI gate |
| R51 | Low installation adoption on iOS | **High** | Medium | An in-app installation guide, shortcuts, patience — and accepting that some iOS users will stay in ordinary browser mode |
| R52 | Web Push does not arrive on iOS | High | Medium | The tiered path push → email → WhatsApp; an important notification never relies on push alone |
| R53 | Bundle size grows as modules are added | Medium | Medium | Per-module loading follows the subscription, and the performance budget is a CI gate |

---

## 12. Metrics

| Metric | Target |
|--------|--------|
| Lighthouse PWA | 100 |
| Lighthouse Performance (mobile) | ≥ 90 |
| LCP p75 on slow 4G | < 2.5 s |
| Installation rate (Android) | ≥ 40% of active users |
| Installation rate (iOS) | ≥ 15% (realistic, not aspirational) |
| Offline punches successfully synced | ≥ 99% |
| Offline punches lost before syncing | < 0.1% |
| Static asset cache hit rate | ≥ 90% |
| Data leaks between users on a shared device | **0** |
| Sessions broken by a stale service worker | < 0.1% |
