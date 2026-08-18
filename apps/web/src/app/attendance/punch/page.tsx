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
 * Layar presensi (dokumen 10).
 *
 * Tiga hal yang membentuk layar ini, dan ketiganya berasal dari prinsip yang
 * sama — bahwa presensi tidak boleh gagal karena hal-hal di luar kendali
 * karyawan:
 *
 * 1. **Izin lokasi yang ditolak tidak merusak apa pun.** Presensi tetap dapat
 *    dikirim, hanya dengan skor kepercayaan lebih rendah dan ditandai untuk
 *    ditinjau HR (P14). Memaksa izin akan membuat orang yang menolak — dengan
 *    alasan yang sah — tidak dapat bekerja.
 *
 * 2. **Tanpa sinyal, presensi masuk antrean.** Bukan gagal, bukan hilang.
 *
 * 3. **Alasan penilaian ditampilkan.** Karyawan melihat jarak, akurasi, dan
 *    skornya sendiri. Sistem yang menilai orang tanpa menunjukkan dasarnya
 *    adalah sistem yang tidak dapat dibantah.
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
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PunchOutcome | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [photo, setPhoto] = useState<{ key: string; preview: string } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
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
    const result = await flushQueue(send).catch(() => null);
    if (result && mounted.current) setQueued(result.remaining);
  }, [send]);

  // Pemicu sinkronisasi BERLAPIS, bukan Background Sync (dokumen 11 §6.1).
  // Background Sync tidak ada di iOS sama sekali; membangun keandalan di atasnya
  // berarti keandalan yang hanya terlihat bekerja saat diuji di Android.
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
      // `enableHighAccuracy` menyalakan GPS, bukan sekadar lokasi jaringan.
      // Timeout 15 detik: GPS dingin di dalam gedung memang selambat itu, dan
      // menyerah lebih cepat berarti selalu memakai lokasi menara seluler.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  }, []);

  /**
   * Mengambil dan mengunggah foto swafoto.
   *
   * Diunggah SEBELUM ketukan dikirim, dan itu disengaja: yang disimpan pada
   * ketukan hanyalah kunci foto, sehingga ketukan tetap kecil dan tetap dapat
   * masuk antrean luring tanpa membawa muatan biner.
   *
   * Konsekuensinya, foto TIDAK dapat diambil saat luring. Itu batas yang
   * diterima: presensi tanpa foto tetap tercatat, hanya dengan skor lebih
   * rendah dan tinjauan HR.
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
      // Dialog kamera ditutup atau gambar tidak terbaca. Bukan galat yang
      // perlu ditampilkan — pengguna dapat mencoba lagi atau melanjutkan
      // tanpa foto.
    }
    setPhotoBusy(false);
  }, [api]);

  const punch = useCallback(
    async (type: 'IN' | 'OUT') => {
      setBusy(true);
      setOutcome(null);

      const item: QueuedPunch = {
        // Dibangkitkan di klien SEBELUM pengiriman. Inilah yang membuat
        // pengiriman ulang dari antrean tidak menggandakan ketukan.
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
          // Gagal saat online tetap masuk antrean. Server yang sedang bermasalah
          // bukan alasan untuk kehilangan presensi seseorang.
          await enqueuePunch(item);
          await refreshQueue();
          setOutcome({ queued: true });
        }
      } catch {
        await enqueuePunch(item);
        await refreshQueue();
        setOutcome({ queued: true });
      }

      // Foto dilepas setelah dipakai. Menyisakannya berarti ketukan berikutnya
      // memakai foto lama — bukti kehadiran yang menunjukkan orang yang benar
      // pada waktu yang salah.
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

        {storageWarning && (
          // Peringatan jujur untuk iOS (risiko R48). Menyembunyikannya berarti
          // membiarkan orang mengandalkan antrean yang dapat lenyap.
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

          {(geo.status === 'idle' || geo.status === 'asking') && (
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

          {(geo.status === 'denied' || geo.status === 'unavailable') && (
            // Izin ditolak TIDAK memblokir presensi. Yang terjadi hanya skor
            // kepercayaan lebih rendah dan tinjauan HR — dan itu dikatakan
            // terus terang, bukan disembunyikan.
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              {geo.message}. Anda tetap dapat melakukan presensi, tetapi catatannya
              akan ditandai untuk diperiksa HR.
            </p>
          )}
        </section>

        <section className="mt-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm font-medium">Foto swafoto</p>

          {photo ? (
            <div className="mt-2 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
          ) : (
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
          )}
        </section>

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
