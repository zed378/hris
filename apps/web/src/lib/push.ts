/**
 * Berlangganan Web Push dari sisi klien (dokumen 11 §7).
 *
 * ## Izin notifikasi hanya dapat diminta sekali
 *
 * Peramban memberi satu kesempatan. Setelah pengguna menolak, `requestPermission`
 * tidak akan pernah menampilkan dialognya lagi — mengubahnya menuntut membuka
 * setelan situs, dan tidak ada yang melakukannya.
 *
 * Karena itu seluruh berkas ini disusun untuk **tidak membakar kesempatan itu**:
 * setiap keadaan yang membuat langganan pasti gagal diperiksa LEBIH DULU, dan
 * izin hanya diminta ketika berlangganan benar-benar dapat berhasil.
 *
 * Yang paling penting di antaranya adalah iOS. Di sana Web Push hanya berfungsi
 * bila PWA sudah dipasang ke Layar Utama; meminta izin sebelum itu menghasilkan
 * penolakan permanen pada pengguna yang sebenarnya bersedia — dan setelah ia
 * memasang PWA-nya, pintu itu sudah tertutup.
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
  // iPadOS 13+ melaporkan dirinya sebagai Macintosh; `maxTouchPoints` yang
  // membedakannya dari Mac sungguhan.
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Properti khusus Safari iOS, tidak ada di tipe standar.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Mengubah kunci VAPID base64url menjadi bentuk yang diterima `subscribe()`. */
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

  // Konfigurasi server diperiksa SEBELUM izin diminta. Instalasi yang belum
  // memasang kunci VAPID akan gagal berlangganan, dan kegagalan itu tidak boleh
  // menghabiskan satu-satunya kesempatan bertanya.
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

    // `subscribe()` mengembalikan langganan yang SUDAH ADA bila masih hidup,
    // sehingga memanggilnya berulang kali aman — dan endpoint yang sama akan
    // di-upsert server, bukan menghasilkan baris kedua.
    const subscription = await registration.pushManager.subscribe({
      // Diwajibkan peramban, dan sengaja tidak dilawan: push senyap adalah
      // kemampuan melacak kehadiran perangkat tanpa sepengetahuan pemiliknya.
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
 * Mencabut langganan perangkat ini.
 *
 * Dipanggil saat logout. Tanpa ini, perangkat bersama tetap menerima notifikasi
 * milik pengguna sebelumnya — nama, tanggal cuti, dan keputusannya muncul di
 * layar terkunci orang lain, dan tidak ada yang menyadarinya karena tidak ada
 * galat yang muncul di mana pun.
 */
export async function unsubscribeFromPush(
  api: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    // Server dulu, peramban kemudian.
    //
    // Urutan sebaliknya meninggalkan baris server yang menunjuk endpoint mati:
    // pengirimannya akan gagal dengan 410 dan barisnya dibuang, tetapi di antara
    // keduanya notifikasi tetap dikirim ke perangkat yang penggunanya sudah
    // keluar. Jendelanya pendek, dan isinya nama orang.
    await api('/api/notifications/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);

    await subscription.unsubscribe();
  } catch {
    // Kegagalan pencabutan tidak boleh menghalangi logout. Yang tertinggal
    // adalah langganan yang akan dibuang server pada pengiriman gagal pertama.
  }
}
