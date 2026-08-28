'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Layar persetujuan pemrosesan data presensi (dokumen 10 §8.2 PR2).
 *
 * Layar tersendiri, bukan kotak centang di dalam alur lain. UU PDP No. 27/2022
 * menuntut persetujuan yang spesifik per tujuan, dan persetujuan yang tercampur
 * ke dalam "Saya menyetujui syarat dan ketentuan" bukan persetujuan atas
 * pengambilan koordinat seseorang.
 *
 * Tiga hal yang membuat halaman ini berbeda dari halaman persetujuan pada
 * umumnya, dan ketiganya disengaja:
 *
 *   1. **Tidak ada tombol "Setuju semua".** Setiap tujuan diputuskan sendiri,
 *      karena itulah arti "spesifik per tujuan".
 *   2. **Akibat penolakan dinyatakan lebih dulu**, sebelum tombolnya ditekan.
 *      Persetujuan tanpa pemahaman akibat bukan persetujuan yang diinformasikan.
 *   3. **Menolak tidak menghalangi presensi.** Kalimat itu ditulis besar dan di
 *      atas, karena ketakutan kehilangan hak absen adalah alasan paling umum
 *      orang menyetujui sesuatu yang tidak ia inginkan — dan persetujuan yang
 *      diberikan karena takut tidak sah.
 */

type ConsentType = 'LOCATION' | 'PHOTO' | 'BIOMETRIC';

interface ConsentState {
  type: ConsentType;
  version: string;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  decided: boolean;
}

const TEKS: Record<
  ConsentType,
  { judul: string; apa: string; tujuan: string; retensi: string; bilaDitolak: string }
> = {
  LOCATION: {
    judul: 'Lokasi saat presensi',
    apa: 'Koordinat GPS perangkat Anda pada detik Anda menekan tombol presensi.',
    tujuan:
      'Memastikan presensi dilakukan di lokasi kerja. Koordinat tidak dipakai untuk ' +
      'menilai kinerja, memetakan pergerakan, atau mengukur lama Anda berada di kantor.',
    retensi:
      'Disimpan bersama catatan presensinya. Tidak diambil di latar belakang — ' +
      'hanya pada detik Anda menekan tombol, tidak pernah di waktu lain.',
    bilaDitolak:
      'Presensi Anda tetap tercatat, tanpa koordinat. Catatannya akan menunjukkan ' +
      'bahwa lokasi tidak disertakan atas permintaan Anda, dan itu bukan pelanggaran.',
  },
  PHOTO: {
    judul: 'Foto swafoto saat presensi',
    apa: 'Satu foto wajah yang diambil kamera depan pada saat presensi.',
    tujuan:
      'Memastikan yang melakukan presensi adalah Anda sendiri. Foto tidak dipakai ' +
      'untuk pengenalan wajah otomatis maupun disimpan sebagai template biometrik.',
    retensi:
      'Dihapus otomatis setelah 90 hari. Catatan presensinya tetap utuh — yang ' +
      'hilang hanya fotonya. Data lokasi di dalam foto (EXIF) dibuang sebelum disimpan.',
    bilaDitolak:
      'Presensi Anda tetap tercatat, tanpa foto. Kamera tidak akan diminta sama sekali.',
  },
  BIOMETRIC: {
    judul: 'Template biometrik wajah',
    apa: 'Representasi matematis wajah Anda untuk pencocokan otomatis.',
    tujuan: 'Belum digunakan pada sistem ini.',
    retensi: 'Belum berlaku.',
    bilaDitolak: 'Tidak berpengaruh; fitur ini belum aktif.',
  },
};

export default function ConsentPage() {
  const { api } = useSession();
  const [consents, setConsents] = useState<ConsentState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ConsentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api('/api/attendance/consent');
    if (response.ok) {
      const json = (await response.json()) as { consents: ConsentState[] };
      setConsents(json.consents);
    } else {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(json?.error?.message ?? 'Persetujuan tidak dapat dimuat.');
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (type: ConsentType, grant: boolean) => {
      setBusy(type);
      const response = await api('/api/attendance/consent', {
        method: 'POST',
        body: JSON.stringify({ type, grant }),
      });
      if (response.ok) {
        const json = (await response.json()) as { consents: ConsentState[] };
        setConsents(json.consents);
      }
      setBusy(null);
    },
    [api],
  );

  const pending = consents.filter((consent) => !consent.decided);

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Persetujuan Data Presensi</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Sesuai UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi. Anda
          memutuskan setiap butir secara terpisah, dan dapat mengubahnya kapan saja.
        </p>
      </header>

      {/* Kalimat ini di atas segalanya, sebelum satu pun tombol terlihat.
          Ketakutan kehilangan hak absen adalah alasan paling umum orang
          menyetujui sesuatu yang tidak ia inginkan. */}
      <p className="mb-5 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <strong>Menolak tidak menghalangi Anda melakukan presensi.</strong> Semua
        butir di bawah ini bersifat sukarela. Presensi Anda tetap tercatat dan tetap
        dihitung, dengan bukti seadanya yang Anda izinkan.
      </p>

      {error && (
        <p className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      {pending.length > 0 && (
        <p className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {pending.length === consents.length
            ? 'Anda belum memutuskan satu pun butir di bawah. Sampai diputuskan, tidak ada lokasi maupun foto yang diambil.'
            : 'Ada butir yang belum Anda putuskan. Sampai diputuskan, data tersebut tidak diambil.'}
        </p>
      )}

      {loading && <p className="text-sm text-slate-400">Memuat…</p>}

      <div className="space-y-4">
        {consents.map((consent) => {
          const teks = TEKS[consent.type];
          return (
            <article
              key={consent.type}
              className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="font-medium">{teks.judul}</h2>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    consent.granted
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                      : consent.decided
                        ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  }`}
                >
                  {consent.granted ? 'Disetujui' : consent.decided ? 'Ditolak' : 'Belum diputuskan'}
                </span>
              </div>

              <dl className="mt-3 space-y-2 text-sm">
                {[
                  ['Yang diambil', teks.apa],
                  ['Untuk apa', teks.tujuan],
                  ['Berapa lama', teks.retensi],
                  ['Bila Anda menolak', teks.bilaDitolak],
                ].map(([label, isi]) => (
                  <div key={label} className="sm:flex sm:gap-3">
                    <dt className="shrink-0 text-slate-500 sm:w-40 dark:text-slate-400">{label}</dt>
                    <dd className="text-slate-700 dark:text-slate-200">{isi}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void decide(consent.type, true)}
                  disabled={busy === consent.type || consent.granted}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
                >
                  Saya setuju
                </button>
                <button
                  onClick={() => void decide(consent.type, false)}
                  disabled={busy === consent.type || (consent.decided && !consent.granted)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {consent.granted ? 'Tarik persetujuan' : 'Saya tidak setuju'}
                </button>

                <span className="text-xs text-slate-400">
                  {consent.granted && consent.grantedAt
                    ? `Disetujui ${new Date(consent.grantedAt).toLocaleString('id-ID')}`
                    : consent.withdrawnAt
                      ? `Ditolak ${new Date(consent.withdrawnAt).toLocaleString('id-ID')}`
                      : `Versi teks ${consent.version}`}
                </span>
              </div>
            </article>
          );
        })}
      </div>

      <p className="mt-5 text-xs text-slate-400">
        Bila teks persetujuan ini berubah — misalnya masa simpan foto diperpanjang —
        Anda akan diminta memutuskan ulang. Persetujuan atas teks lama tidak
        diberlakukan untuk teks baru.
      </p>
    </AppShell>
  );
}
