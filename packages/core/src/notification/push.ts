import webpush from 'web-push';
import { log } from '@hrms/observability';
import { type TenantClient } from '@hrms/db';

/**
 * Web Push (dokumen 11 §7).
 *
 * `NotificationChannel.WEB_PUSH` ada di enum sejak modul notifikasi dibangun,
 * tanpa satu pun produsen. Berkas ini yang mengisinya.
 *
 * ## Push TIDAK PERNAH menjadi satu-satunya jalur
 *
 * Dokumen 04 §R52 menyebutnya sebagai risiko tinggi, dan alasannya bukan
 * kerapuhan jaringan: **Web Push tidak berfungsi di iOS kecuali PWA sudah
 * dipasang ke Layar Utama.** Sebagian besar pengguna tidak akan memasangnya, dan
 * bagi mereka push yang "terkirim" tidak pernah muncul di mana pun.
 *
 * Karena itu bentuknya di sini adalah **tambahan, bukan pengganti**. Email tetap
 * dikirim untuk hal yang penting; push hanya membuatnya sampai lebih cepat bagi
 * yang perangkatnya mendukung. Mengganti email dengan push berarti memindahkan
 * kabar "cuti Anda ditolak" ke saluran yang diam-diam tidak sampai untuk
 * separuh pengguna.
 *
 * ## Kegagalan diperlakukan sebagai fakta, bukan galat
 *
 * Langganan push mati tanpa memberi tahu siapa pun: pengguna menghapus
 * peramban, mencabut izin, atau perangkatnya diganti. Layanan push menjawab
 * 404/410 untuk endpoint yang sudah tidak berlaku, dan jawaban itu **bukan
 * masalah yang perlu dicatat sebagai kegagalan** — ia keterangan bahwa barisnya
 * layak dihapus. Memperlakukannya sebagai galat akan mengisi log dengan
 * kejadian yang tidak dapat ditindaklanjuti siapa pun.
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null | undefined;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Notifikasi ber-tag sama saling menimpa, bukan menumpuk. */
  tag: string;
  /** Dibuka saat notifikasinya diklik. */
  url: string;
}

/**
 * Kunci VAPID, dibaca sekali.
 *
 * Ketiadaannya **bukan galat** — ia berarti push belum dikonfigurasi, dan
 * sistem harus tetap berjalan tanpanya. Melempar di sini akan menjatuhkan
 * seluruh pengiriman notifikasi hanya karena satu saluran opsional tidak
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

/** Kunci publik untuk klien. Aman dibagikan — memang harus. */
export function pushPublicKey(): string | null {
  return vapid()?.publicKey ?? null;
}

export async function saveSubscription(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  input: PushSubscriptionInput,
): Promise<{ id: string }> {
  // Upsert atas endpoint, bukan create. Peramban mengembalikan endpoint yang
  // SAMA bila langganannya masih hidup, dan `subscribe()` dipanggil setiap kali
  // aplikasi dimuat — create akan gagal pada muat kedua.
  //
  // Pemiliknya ikut diperbarui: satu perangkat bersama yang berpindah pengguna
  // harus mengirim notifikasi kepada yang sekarang memakainya, bukan kepada yang
  // kemarin. Ini kelas yang sama dengan antrean presensi luring, dan di sini
  // jawabannya berbeda karena langganan push memang milik sesi peramban, bukan
  // milik perangkat.
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

/** Menghapus seluruh langganan seorang pengguna. Dipakai saat logout. */
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
  /** Langganan mati yang dihapus. Bukan kegagalan. */
  pruned: number;
  failed: number;
}

/**
 * Mengirim satu notifikasi ke seluruh perangkat seorang pengguna.
 *
 * Mengembalikan `sent: 0` bila push belum dikonfigurasi atau penggunanya tidak
 * punya langganan. Keduanya keadaan normal, bukan kegagalan.
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
        // TTL: notifikasi cuti yang sampai tiga hari kemudian tidak berguna.
        // Layanan push menyimpannya selama ini bila perangkatnya sedang mati.
        { TTL: 12 * 3600 },
      );

      await tx.pushSubscription.update({
        where: { id: subscription.id },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      });
      result.sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      // 404/410 berarti endpoint-nya sudah tidak berlaku — pengguna menghapus
      // peramban, mencabut izin, atau perangkatnya diganti. Barisnya dihapus,
      // dan itu BUKAN kegagalan: mencatatnya sebagai galat akan mengisi log
      // dengan kejadian yang tidak dapat ditindaklanjuti siapa pun.
      if (status === 404 || status === 410) {
        await tx.pushSubscription.delete({ where: { id: subscription.id } });
        result.pruned += 1;
        continue;
      }

      // Sisanya dihitung, dan langganan yang gagal berulang kali dibuang.
      // Tanpa batas ini, endpoint yang rusak diam-diam akan dicoba selamanya.
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
