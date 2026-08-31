'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Work sites and their geofences (document 10 §3.2).
 *
 * `attendance.work_sites` has been read on every single punch since Phase 3: it
 * is what turns a pair of coordinates into "40 metres from the Jakarta office"
 * or "2.3 km away, flagged". `GET` and `POST` endpoints existed. **No screen
 * did.**
 *
 * So a tenant could not draw a geofence at all. A pilot registering on their own
 * — which is what Gate A asks them to do — had every punch scored against no
 * site, which means no distance, which means every punch either flagged or
 * accepted on nothing. The evidence layer that documents 10 and 11 spend pages
 * justifying was, for a self-service tenant, switched off and unreachable.
 *
 * This is the same class as bug #34 in PLAN/13 (a menu leading nowhere) with the
 * halves swapped: an endpoint nobody could reach. The permanent guard for the
 * first half — `menu-coverage.test.ts` — could not see this one, because a menu
 * pointing at a missing page is visible from the seed while a missing screen is
 * visible from nothing at all.
 *
 * ## The office network list
 *
 * The second column of this screen is what makes `FALLBACK_ONLY` a real policy
 * rather than a synonym for `ALLOW_FLAGGED` (document 11 §2.2). Two things about
 * it are worth stating on the screen itself rather than in a document nobody
 * opens:
 *
 *   - A punch from one of these networks stops carrying the browser penalty. It
 *     does not score above a normal punch, and it is not a substitute for being
 *     inside the fence.
 *   - A range wide enough to cover a mobile carrier covers everyone in the
 *     country. The limit is not technical — it is that the evidence stops
 *     meaning anything.
 */

interface Site {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  maxAccuracyM: number;
  ipRanges: string[];
}

interface Draft {
  code: string;
  name: string;
  latitude: string;
  longitude: string;
  radiusM: string;
  maxAccuracyM: string;
}

const EMPTY: Draft = {
  code: '',
  name: '',
  latitude: '',
  longitude: '',
  radiusM: '150',
  maxAccuracyM: '100',
};

export default function WorkSitesPage(): React.ReactElement {
  const { api, can } = useSession();
  const manage = can('attendance.shift.manage');

  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [ranges, setRanges] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const response = await api('/api/attendance/work-sites');
    if (response.ok) {
      const json = (await response.json()) as { sites: Site[] };
      setSites(json.sites);
      // The textarea holds one range per line. Kept beside the list rather than
      // inside it so an unsaved edit survives a reload of the list itself.
      setRanges(
        Object.fromEntries(json.sites.map((s) => [s.id, s.ipRanges.join('\n')])),
      );
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const response = await api('/api/attendance/work-sites', {
      method: 'POST',
      body: JSON.stringify({
        code: draft.code,
        name: draft.name,
        latitude: Number(draft.latitude),
        longitude: Number(draft.longitude),
        radiusM: Number(draft.radiusM),
        maxAccuracyM: Number(draft.maxAccuracyM),
      }),
    });

    if (response.ok) {
      setDraft(EMPTY);
      setMessage('Lokasi kerja ditambahkan.');
      await load();
    } else {
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setMessage(json?.error?.message ?? 'Gagal menyimpan lokasi kerja.');
    }
    setBusy(false);
  }, [api, draft, load]);

  const save = useCallback(
    async (id: string, patch: Record<string, unknown>, note: string) => {
      setBusy(true);
      setMessage(null);

      const response = await api(`/api/attendance/work-sites/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });

      if (response.ok) {
        setMessage(note);
        await load();
      } else {
        const json = (await response.json().catch(() => null)) as
          | { error?: { message?: string; details?: Record<string, string[]> } }
          | null;
        const detail = Object.values(json?.error?.details ?? {})
          .flat()
          .join(' ');
        setMessage(detail || json?.error?.message || 'Gagal menyimpan perubahan.');
      }
      setBusy(false);
    },
    [api, load],
  );

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Lokasi Kerja</h1>
      <div className="mt-4 space-y-6">
        <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          Setiap presensi dinilai terhadap lokasi kerja TERDEKAT: jaraknya
          menentukan apakah ketukan itu diterima langsung atau masuk antrean
          tinjauan. Tanpa satu pun lokasi terdaftar, presensi tetap tercatat
          tetapi tidak ada jarak yang dapat dihitung — dan tidak ada yang dapat
          dibuktikan saat terjadi sengketa.
        </p>

        {message && (
          <p className="rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">{message}</p>
        )}

        {loading ? (
          <p className="text-sm text-slate-500">Memuat…</p>
        ) : sites.length === 0 ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Belum ada lokasi kerja. Sampai ada, setiap presensi tercatat tanpa
            jarak — geofence tidak menilai apa pun.
          </p>
        ) : (
          <ul className="space-y-4">
            {sites.map((site) => (
              <li
                key={site.id}
                className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-medium">
                    {site.name}{' '}
                    <span className="text-xs uppercase text-slate-500">{site.code}</span>
                  </h2>
                  <span className="text-xs text-slate-500">
                    {site.latitude.toFixed(6)}, {site.longitude.toFixed(6)}
                  </span>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="block text-slate-600 dark:text-slate-400">
                      Radius geofence (meter)
                    </span>
                    <input
                      type="number"
                      min={20}
                      max={5000}
                      defaultValue={site.radiusM}
                      disabled={!manage || busy}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (value !== site.radiusM) {
                          void save(site.id, { radiusM: value }, 'Radius diperbarui.');
                        }
                      }}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    />
                    <span className="mt-1 block text-xs text-slate-500">
                      Satu gedung perkantoran biasanya 100–200 m; area pabrik jauh
                      lebih besar.
                    </span>
                  </label>

                  <label className="block text-sm">
                    <span className="block text-slate-600 dark:text-slate-400">
                      Akurasi GPS maksimum yang diterima (meter)
                    </span>
                    <input
                      type="number"
                      min={10}
                      max={1000}
                      defaultValue={site.maxAccuracyM}
                      disabled={!manage || busy}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (value !== site.maxAccuracyM) {
                          void save(site.id, { maxAccuracyM: value }, 'Ambang akurasi diperbarui.');
                        }
                      }}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    />
                    <span className="mt-1 block text-xs text-slate-500">
                      GPS di dalam gedung kerap melaporkan 100 m atau lebih.
                      Terlalu ketat berarti seluruh kantor masuk antrean tinjauan
                      setiap hari (risiko R43).
                    </span>
                  </label>
                </div>

                <label className="mt-3 block text-sm">
                  <span className="block text-slate-600 dark:text-slate-400">
                    Jaringan kantor — satu per baris
                  </span>
                  <textarea
                    rows={3}
                    value={ranges[site.id] ?? ''}
                    disabled={!manage || busy}
                    onChange={(e) => setRanges({ ...ranges, [site.id]: e.target.value })}
                    placeholder={'203.0.113.0/24\n2001:db8::/32'}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <span className="mt-1 block text-xs text-slate-500">
                    Presensi dari jaringan ini tidak lagi dikenai penalti
                    &ldquo;dari peramban&rdquo;: alamat asal permintaan adalah
                    satu-satunya bukti yang tidak dapat dipalsukan dari dalam
                    peramban. Ia BUKAN pengganti geofence — jaringan seluas
                    operator seluler berarti seluruh Indonesia dianggap kantor.
                  </span>
                  {manage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const list = (ranges[site.id] ?? '')
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean);
                        void save(site.id, { ipRanges: list }, 'Jaringan kantor diperbarui.');
                      }}
                      className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                    >
                      Simpan jaringan
                    </button>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {manage && (
          <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="font-medium">Tambah lokasi kerja</h2>
            <p className="mt-1 text-xs text-slate-500">
              Koordinat diambil dari peta mana pun: klik kanan titik lokasinya di
              Google Maps, dan angka pertama adalah lintang.
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">Kode</span>
                <input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="pusat"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">Nama</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Kantor Pusat"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">Lintang</span>
                <input
                  value={draft.latitude}
                  onChange={(e) => setDraft({ ...draft, latitude: e.target.value })}
                  placeholder="-6.175392"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">Bujur</span>
                <input
                  value={draft.longitude}
                  onChange={(e) => setDraft({ ...draft, longitude: e.target.value })}
                  placeholder="106.827153"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">Radius (meter)</span>
                <input
                  type="number"
                  value={draft.radiusM}
                  onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-slate-600 dark:text-slate-400">
                  Akurasi maksimum (meter)
                </span>
                <input
                  type="number"
                  value={draft.maxAccuracyM}
                  onChange={(e) => setDraft({ ...draft, maxAccuracyM: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            </div>

            <button
              type="button"
              disabled={busy || !draft.code || !draft.name || !draft.latitude || !draft.longitude}
              onClick={() => void create()}
              className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              Tambah lokasi
            </button>
          </section>
        )}
      </div>
    </AppShell>
  );
}
