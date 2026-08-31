'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { compressImage, openCamera } from '@/lib/capture-photo.ts';
import {
  enqueuePunch,
  flushQueue,
  queuedPunches,
  requestPersistentStorage,
  type QueuedPunch,
} from '@/lib/offline-queue.ts';

/**
 * The attendance screen (document 10).
 *
 * Three things shape this screen, and all three come from the same principle —
 * that punching in must not fail because of things outside an employee's
 * control:
 *
 * 1. **A denied location permission breaks nothing.** The punch can still be
 *    sent, only with a lower trust score and flagged for HR review (P14).
 *    Forcing the permission would leave someone who refuses — for a legitimate
 *    reason — unable to work.
 *
 * 2. **With no signal, the punch is queued.** Not failed, not lost.
 *
 * 3. **The reason for the score is shown.** The employee sees the distance, the
 *    accuracy, and their own score. A system that judges people without showing
 *    its basis is a system that cannot be argued with.
 */

interface GeoState {
  status: 'idle' | 'asking' | 'ok' | 'denied' | 'unavailable';
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  message: string | null;
}

interface PunchOutcome {
  queued: boolean;
  trustScore?: number;
  flags?: Array<{ code: string; message: string }>;
  needsReview?: boolean;
}

export default function PunchPage() {
  const { api, bootstrap } = useSession();

  const [geo, setGeo] = useState<GeoState>({
    status: 'idle',
    latitude: null,
    longitude: null,
    accuracyM: null,
    message: null,
  });
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  /** Punches belonging to another user on this device. Shown, not hidden. */
  const [otherUsersQueued, setOtherUsersQueued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PunchOutcome | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [photo, setPhoto] = useState<{ key: string; preview: string } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  /**
   * The Personal Data Protection Act consent in force for this user.
   *
   * `null` until it has been read. Until then the location and camera buttons
   * are not shown — the correct default for personal data is not to collect it
   * until it is clearly allowed, not the reverse.
   */
  const [consent, setConsent] = useState<{
    location: boolean;
    photo: boolean;
    pending: string[];
  } | null>(null);
  const mounted = useRef(true);

  const refreshQueue = useCallback(async () => {
    const items = await queuedPunches().catch(() => []);
    if (mounted.current) setQueued(items.length);
  }, []);

  const send = useCallback(
    (punch: QueuedPunch) =>
      api('/api/attendance/punch', {
        method: 'POST',
        body: JSON.stringify({
          type: punch.type,
          punchedAt: punch.punchedAt,
          latitude: punch.latitude,
          longitude: punch.longitude,
          accuracyM: punch.accuracyM,
          photoKey: punch.photoKey,
          dedupeKey: punch.dedupeKey,
          deviceInfo: punch.deviceInfo,
        }),
      }),
    [api],
  );

  const flush = useCallback(async () => {
    const userId = bootstrap?.user.id;
    if (!userId) return;

    const result = await flushQueue(send, userId).catch(() => null);
    if (result && mounted.current) {
      setQueued(result.remaining);
      setOtherUsersQueued(result.otherUsers);
    }
  }, [send, bootstrap?.user.id]);

  // LAYERED sync triggers, not Background Sync (document 11 §6.1). Background
  // Sync does not exist on iOS at all; building reliability on it means
  // reliability that only appears to work when tested on Android.
  useEffect(() => {
    mounted.current = true;
    void refreshQueue();
    void requestPersistentStorage().then((ok) => {
      if (mounted.current) setStorageWarning(!ok);
    });

    const goOnline = () => {
      setOnline(true);
      void flush();
    };
    const goOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void flush();
    };

    setOnline(navigator.onLine);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', onVisible);
    void flush();

    return () => {
      mounted.current = false;
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flush, refreshQueue]);

  useEffect(() => {
    void (async () => {
      const response = await api('/api/attendance/consent');
      if (!response.ok) {
        // A failure to read the consent is treated as no consent. The punch can
        // still be made; what is not done is collecting personal data on a
        // guess.
        setConsent({ location: false, photo: false, pending: [] });
        return;
      }
      const json = (await response.json()) as {
        consents: Array<{ type: string; granted: boolean; decided: boolean }>;
      };
      setConsent({
        location: json.consents.some((c) => c.type === 'LOCATION' && c.granted),
        photo: json.consents.some((c) => c.type === 'PHOTO' && c.granted),
        pending: json.consents.filter((c) => !c.decided).map((c) => c.type),
      });
    })();
  }, [api]);

  const askLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGeo((g) => ({ ...g, status: 'unavailable', message: 'Perangkat tidak mendukung lokasi' }));
      return;
    }

    setGeo((g) => ({ ...g, status: 'asking', message: null }));
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setGeo({
          status: 'ok',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Math.round(position.coords.accuracy),
          message: null,
        }),
      (error) =>
        setGeo({
          status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable',
          latitude: null,
          longitude: null,
          accuracyM: null,
          message:
            error.code === error.PERMISSION_DENIED
              ? 'Izin lokasi ditolak'
              : 'Lokasi tidak dapat dibaca saat ini',
        }),
      // `enableHighAccuracy` turns on GPS rather than network location alone.
      // A 15-second timeout: a cold GPS fix indoors really is that slow, and
      // giving up sooner means always using the cell tower location.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  }, []);

  /**
   * Captures and uploads the selfie.
   *
   * Uploaded BEFORE the punch is sent, and that is deliberate: what the punch
   * stores is only the photo key, so the punch stays small and can still enter
   * the offline queue without carrying a binary payload.
   *
   * The consequence is that a photo CANNOT be taken while offline. That is an
   * accepted limit: a punch with no photo is still recorded, only with a lower
   * score and an HR review.
   */
  const takePhoto = useCallback(async () => {
    setPhotoBusy(true);
    try {
      const file = await openCamera();
      const compressed = await compressImage(file);

      const body = new FormData();
      body.append('photo', compressed, 'selfie.jpg');

      const response = await api('/api/attendance/photo', { method: 'POST', body });
      if (response.ok) {
        const { key } = (await response.json()) as { key: string };
        setPhoto({ key, preview: URL.createObjectURL(compressed) });
      }
    } catch {
      // The camera dialog was closed or the image could not be read. Not an
      // error worth showing — the user can try again or carry on without a
      // photo.
    }
    setPhotoBusy(false);
  }, [api]);

  const punch = useCallback(
    async (type: 'IN' | 'OUT') => {
      setBusy(true);
      setOutcome(null);

      const item: QueuedPunch = {
        // The owner marker. The queue survives a logout, and without this
        // someone's punch could be sent on behalf of the next user to log in on
        // the same device — see `offline-queue.ts`.
        ownerUserId: bootstrap?.user.id ?? 'anonim',
        // Generated on the client BEFORE sending. This is what stops a resend
        // from the queue duplicating the punch.
        dedupeKey: crypto.randomUUID(),
        type,
        punchedAt: new Date().toISOString(),
        latitude: geo.latitude,
        longitude: geo.longitude,
        accuracyM: geo.accuracyM,
        photoKey: photo?.key ?? null,
        deviceInfo: navigator.userAgent.slice(0, 200),
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };

      if (!navigator.onLine) {
        await enqueuePunch(item);
        await refreshQueue();
        setOutcome({ queued: true });
        setBusy(false);
        return;
      }

      try {
        const response = await send(item);
        if (response.ok) {
          const body = (await response.json()) as {
            trustScore: number;
            flags: Array<{ code: string; message: string }>;
            needsReview: boolean;
          };
          setOutcome({ queued: false, ...body });
        } else {
          // A failure while online still enters the queue. A server having
          // trouble is no reason to lose somebody's attendance.
          await enqueuePunch(item);
          await refreshQueue();
          setOutcome({ queued: true });
        }
      } catch {
        await enqueuePunch(item);
        await refreshQueue();
        setOutcome({ queued: true });
      }

      // The photo is released once used. Keeping it would make the next punch
      // use the old photo — evidence of attendance showing the right person at
      // the wrong time.
      setPhoto(null);
      setBusy(false);
    },
    [geo, photo, refreshQueue, send],
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-semibold">Presensi</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {bootstrap?.user.fullName}
        </p>

        {!online && (
          <p className="mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            Tidak ada koneksi. Presensi tetap dapat dilakukan dan akan terkirim
            otomatis saat jaringan pulih.
          </p>
        )}

        {queued > 0 && (
          <p className="mt-3 rounded-md bg-slate-100 px-4 py-3 text-sm dark:bg-slate-800">
            {queued} presensi menunggu terkirim.{' '}
            <button onClick={() => void flush()} className="text-brand-600 underline">
              Coba kirim sekarang
            </button>
          </p>
        )}

        {/* Ketukan milik pengguna lain di perangkat yang sama.
            
            Ditampilkan, bukan disembunyikan: pada perangkat bersama seseorang
            perlu tahu bahwa presensi rekannya masih tertahan, supaya ia dapat
            memberitahunya untuk masuk dan mengirimkannya. Menyembunyikannya
            berarti presensi itu hilang tanpa ada yang menyadarinya. */}
        {otherUsersQueued > 0 && (
          <p className="mt-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {otherUsersQueued} presensi milik pengguna lain masih tertahan di
            perangkat ini. Ia hanya dapat terkirim setelah pemiliknya masuk —
            presensi tidak pernah dikirim atas nama orang lain.
          </p>
        )}

        {storageWarning && (
          // An honest warning for iOS (risk R48). Hiding it means letting people
          // rely on a queue that can disappear.
          <p className="mt-3 rounded-md bg-slate-100 px-4 py-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            Peramban tidak menjamin penyimpanan permanen. Bila Anda sering bekerja
            tanpa sinyal, pasang aplikasi ini ke layar utama agar antrean presensi
            tidak terhapus.
          </p>
        )}

        <section className="mt-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm font-medium">Lokasi</p>

          {geo.status === 'ok' && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Terbaca — akurasi ±{geo.accuracyM} m
            </p>
          )}

          {consent !== null && !consent.location && (
            // Location consent was not given: the button is not shown at all.
            // Showing it and then refusing on the server would still make the
            // browser ask for GPS permission — a request already answered "no"
            // on the consent screen.
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Lokasi tidak diambil sesuai pilihan Anda pada{' '}
              <a href="/attendance/consent" className="text-brand-600 underline">
                Persetujuan Data Presensi
              </a>
              . Presensi Anda tetap tercatat.
            </p>
          )}

          {consent?.location && (geo.status === 'idle' || geo.status === 'asking') && (
            <>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Lokasi dipakai untuk memastikan Anda berada di area kerja. Diambil
                hanya saat menekan tombol presensi — tidak pernah di latar belakang.
              </p>
              <button
                onClick={askLocation}
                disabled={geo.status === 'asking'}
                className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {geo.status === 'asking' ? 'Membaca lokasi…' : 'Aktifkan lokasi'}
              </button>
            </>
          )}

          {consent?.location && (geo.status === 'denied' || geo.status === 'unavailable') && (
            // A denied permission does NOT block the punch. All that happens is a
            // lower trust score and an HR review — and that is said plainly
            // rather than hidden.
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              {geo.message}. Anda tetap dapat melakukan presensi, tetapi catatannya
              akan ditandai untuk diperiksa HR.
            </p>
          )}
        </section>

        <section className="mt-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm font-medium">Foto swafoto</p>

          {consent !== null && !consent.photo && (
            // The camera is not requested at all. This is the most concrete
            // promise on the consent screen, and the only way to keep it is never
            // to call getUserMedia.
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Foto tidak diambil sesuai pilihan Anda pada{' '}
              <a href="/attendance/consent" className="text-brand-600 underline">
                Persetujuan Data Presensi
              </a>
              .
            </p>
          )}

          {consent?.photo && photo ? (
            <div className="mt-2 flex items-center gap-3">
              {/* `next/image` sengaja tidak dipakai di sini: sumbernya blob:
                  URL dari kamera perangkat, yang tidak dapat dioptimasi server
                  dan memang tidak perlu — berkasnya sudah dikompresi klien dan
                  tidak pernah meninggalkan halaman ini sebelum dikirim. */}
              <img
                src={photo.preview}
                alt="Pratinjau foto presensi"
                className="h-20 w-20 rounded-md object-cover"
              />
              <button
                onClick={() => void takePhoto()}
                className="text-sm text-brand-600 underline"
              >
                Ambil ulang
              </button>
            </div>
          ) : consent?.photo ? (
            <>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Foto menaikkan keandalan bukti presensi Anda. Disimpan 90 hari,
                lalu dihapus otomatis.
              </p>
              <button
                onClick={() => void takePhoto()}
                disabled={photoBusy || !online}
                className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {photoBusy ? 'Memproses…' : online ? 'Ambil foto' : 'Perlu koneksi'}
              </button>
            </>
          ) : null}
        </section>

        {consent && consent.pending.length > 0 && (
          // Placed directly above the punch button rather than at the top of the
          // page: this is the moment people actually read it.
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Anda belum memutuskan apakah lokasi dan foto boleh diambil saat presensi.{' '}
            <a href="/attendance/consent" className="underline">
              Putuskan sekarang
            </a>
            . Presensi tetap dapat dilakukan tanpa memutuskannya.
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            onClick={() => void punch('IN')}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-6 text-lg font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            Masuk
          </button>
          <button
            onClick={() => void punch('OUT')}
            disabled={busy}
            className="rounded-lg bg-slate-700 px-4 py-6 text-lg font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            Pulang
          </button>
        </div>

        {outcome && (
          <section className="mt-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            {outcome.queued ? (
              <>
                <p className="font-medium">Presensi tersimpan di perangkat</p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Akan terkirim otomatis saat jaringan tersedia. Jam presensi yang
                  tercatat adalah jam Anda menekan tombol, bukan jam pengiriman.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">
                  {outcome.needsReview ? 'Presensi tercatat, menunggu tinjauan' : 'Presensi tercatat'}
                </p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Skor kepercayaan {outcome.trustScore}/100
                </p>
                {/* Alasan penilaian ditampilkan kepada karyawan, bukan hanya
                    kepada HR (dokumen 10 §8.2). Sistem yang menilai orang tanpa
                    menunjukkan dasarnya tidak dapat dibantah. */}
                {outcome.flags && outcome.flags.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-amber-700 dark:text-amber-300">
                    {outcome.flags.map((flag) => (
                      <li key={flag.code}>• {flag.message}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        <p className="mt-6 text-center text-xs text-slate-400">
          Lokasi hanya dipakai untuk verifikasi presensi dan tidak diteruskan ke
          laporan mana pun sebagai koordinat. Foto presensi disimpan 90 hari.
        </p>
      </div>
    </AppShell>
  );
}
