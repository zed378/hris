'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdminSession } from './admin-session.tsx';

/**
 * Konsol control plane.
 *
 * Sampai sekarang bidang admin hanya berupa endpoint: menangguhkan pelanggan
 * yang tidak membayar, atau menyalakan modul yang baru dibelinya, hanya dapat
 * dilakukan lewat `curl` dengan token yang diambil manual. Itu bukan operasi
 * yang layak dilakukan dua kali — dan operasi yang tidak layak dilakukan dua
 * kali adalah operasi yang akhirnya dilakukan dengan salin-tempel yang keliru.
 *
 * Satu halaman, bukan beberapa. Yang dikerjakan di sini ada tiga — melihat
 * ringkasan, mencari tenant, mengubah keadaannya — dan memecahnya menjadi tiga
 * rute berarti tiga kali muat ulang, yang pada bidang tanpa sesi persisten
 * berarti tiga kali TOTP.
 */

interface Overview {
  tenants: Record<string, number>;
  totalUsers: number;
  modulesInUse: Array<{ moduleCode: string; tenants: number }>;
}

interface TenantRow {
  id: string;
  code: string;
  name: string;
  status: string;
  planCode: string;
  trialEndsAt: string | null;
  createdAt: string;
  moduleCount: number;
  userCount: number;
}

interface TenantDetail extends TenantRow {
  suspendedAt: string | null;
  churnedAt: string | null;
  modules: Array<{
    code: string;
    name: string;
    tier: string;
    isCore: boolean;
    inPlan: boolean;
    enabled: boolean;
  }>;
}

const STATUS_TONE: Record<string, string> = {
  TRIAL: 'bg-amber-100 text-amber-800',
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  SUSPENDED: 'bg-rose-100 text-rose-800',
  CHURNED: 'bg-slate-200 text-slate-600',
};

const FIELD =
  'rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900';

export default function AdminPage() {
  const { token, email, masuk, keluar, api } = useAdminSession();

  if (!token) return <LayarMasuk onMasuk={masuk} />;

  return <Konsol email={email} onKeluar={keluar} api={api} />;
}

// ---------------------------------------------------------------------------

function LayarMasuk({ onMasuk }: { onMasuk: (token: string, email: string) => void }) {
  const [form, setForm] = useState({ email: '', password: '', totp: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kirim = useCallback(async () => {
    setBusy(true);
    setError(null);

    const response = await fetch('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });

    if (response.ok) {
      const json = (await response.json()) as { token: string };
      onMasuk(json.token, form.email);
    } else {
      // Pesannya sengaja tidak membedakan kata sandi salah dari TOTP salah —
      // server pun tidak. Membedakannya memberi tahu penyerang bahwa kata
      // sandinya sudah benar, dan bagi akun yang memegang kunci ke seluruh
      // platform, informasi itu tidak perlu diberikan.
      setError('Kredensial tidak sah.');
    }
    setBusy(false);
  }, [form, onMasuk]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-lg border border-slate-300 bg-white p-6">
        <h1 className="text-lg font-semibold">Control Plane</h1>
        <p className="mt-1 text-sm text-slate-500">
          Bidang internal. Bukan tempat masuk pelanggan.
        </p>

        <div className="mt-5 space-y-3">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="Email"
            className={`${FIELD} w-full`}
          />
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="Kata sandi"
            className={`${FIELD} w-full`}
          />
          <input
            inputMode="numeric"
            value={form.totp}
            onChange={(e) => setForm((f) => ({ ...f, totp: e.target.value.replace(/\D/g, '') }))}
            placeholder="Kode TOTP 6 digit"
            maxLength={6}
            className={`${FIELD} w-full font-mono tracking-widest`}
          />
        </div>

        {error && (
          <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
        )}

        <button
          onClick={() => void kirim()}
          disabled={busy || form.totp.length !== 6}
          className="mt-4 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>

        {/*
          Dinyatakan di layar masuk, bukan ditemukan sendiri saat halaman
          disegarkan dan sesinya hilang.
        */}
        <p className="mt-4 text-xs text-slate-500">
          Sesi hanya bertahan selama tab ini terbuka. Menyegarkan halaman berarti
          masuk lagi — token bidang ini sengaja tidak disimpan di peramban.
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Konsol({
  email,
  onKeluar,
  api,
}: {
  email: string | null;
  onKeluar: () => void;
  api: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [cari, setCari] = useState('');
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [pesan, setPesan] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const muat = useCallback(async () => {
    const [ovRes, tenantRes] = await Promise.all([
      api('/admin/api/overview'),
      api('/admin/api/tenants?limit=100'),
    ]);
    if (ovRes.ok) setOverview((await ovRes.json()) as Overview);
    if (tenantRes.ok) setTenants(((await tenantRes.json()) as { tenants: TenantRow[] }).tenants);
  }, [api]);

  useEffect(() => {
    void muat();
  }, [muat]);

  const bukaDetail = useCallback(
    async (tenantId: string) => {
      const response = await api(`/admin/api/tenants/detail?tenantId=${tenantId}`);
      if (response.ok) setDetail((await response.json()) as TenantDetail);
    },
    [api],
  );

  const ubahModul = useCallback(
    async (tenantId: string, moduleCode: string, enabled: boolean) => {
      setBusy(true);
      setPesan(null);
      const response = await api('/admin/api/tenants', {
        method: 'POST',
        body: JSON.stringify({ tenantId, moduleCode, enabled }),
      });
      if (response.ok) {
        setPesan({
          tone: 'ok',
          text: `Modul "${moduleCode}" ${enabled ? 'dinyalakan' : 'dimatikan'}. Datanya tidak dihapus.`,
        });
        await bukaDetail(tenantId);
        await muat();
      } else {
        const json = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setPesan({ tone: 'error', text: json?.error?.message ?? 'Perubahan modul gagal.' });
      }
      setBusy(false);
    },
    [api, bukaDetail, muat],
  );

  const ubahStatus = useCallback(
    async (tenantId: string, status: string) => {
      // Alasan diminta di sini, bukan opsional, karena server memang menolaknya
      // tanpa alasan — dan "menonaktifkan seluruh akses satu perusahaan" adalah
      // tindakan yang harus meninggalkan kalimat, bukan hanya stempel waktu.
      const alasan = window.prompt(
        `Alasan mengubah status menjadi ${status}? (minimal 8 karakter, tercatat di jejak audit platform)`,
      );
      if (!alasan || alasan.trim().length < 8) return;

      setBusy(true);
      setPesan(null);
      const response = await api('/admin/api/tenants/status', {
        method: 'POST',
        body: JSON.stringify({ tenantId, status, reason: alasan.trim() }),
      });
      if (response.ok) {
        setPesan({
          tone: 'ok',
          text:
            status === 'SUSPENDED'
              ? 'Tenant ditangguhkan. Login dan refresh ditolak sejak sekarang; sesi yang sudah berjalan berakhir saat token-nya kedaluwarsa. Tidak ada data yang dihapus.'
              : `Status diubah menjadi ${status}.`,
        });
        await bukaDetail(tenantId);
        await muat();
      } else {
        const json = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setPesan({ tone: 'error', text: json?.error?.message ?? 'Perubahan status gagal.' });
      }
      setBusy(false);
    },
    [api, bukaDetail, muat],
  );

  const terlihat = tenants.filter(
    (t) =>
      cari === '' ||
      t.code.toLowerCase().includes(cari.toLowerCase()) ||
      t.name.toLowerCase().includes(cari.toLowerCase()),
  );

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Control Plane</h1>
            <p className="text-sm text-slate-500">{email}</p>
          </div>
          <button
            onClick={onKeluar}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm transition hover:bg-slate-50"
          >
            Keluar
          </button>
        </header>

        {pesan && (
          <p
            className={`mt-4 rounded-md px-4 py-3 text-sm ${
              pesan.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900'
            }`}
          >
            {pesan.text}
          </p>
        )}

        {overview && (
          <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(overview.tenants).map(([status, jumlah]) => (
              <div key={status} className="rounded-lg border border-slate-300 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">{status}</p>
                <p className="mt-1 text-2xl font-semibold">{jumlah}</p>
              </div>
            ))}
            <div className="rounded-lg border border-slate-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-slate-400">Total pengguna</p>
              <p className="mt-1 text-2xl font-semibold">{overview.totalUsers}</p>
            </div>
          </section>
        )}

        <section className="mt-6 rounded-lg border border-slate-300 bg-white">
          <div className="border-b border-slate-200 p-4">
            <input
              value={cari}
              onChange={(e) => setCari(e.target.value)}
              placeholder="Cari kode atau nama perusahaan…"
              className={`${FIELD} w-full sm:w-96`}
            />
          </div>

          <table className="min-w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="px-4 py-2">Kode</th>
                <th className="px-4 py-2">Nama</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Paket</th>
                <th className="px-4 py-2">Modul</th>
                <th className="px-4 py-2">Pengguna</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {terlihat.map((tenant) => (
                <tr key={tenant.id} className="border-t border-slate-200">
                  <td className="px-4 py-2 font-mono text-xs">{tenant.code}</td>
                  <td className="px-4 py-2">{tenant.name}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        STATUS_TONE[tenant.status] ?? STATUS_TONE['CHURNED']!
                      }`}
                    >
                      {tenant.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">{tenant.planCode}</td>
                  <td className="px-4 py-2">{tenant.moduleCount}</td>
                  <td className="px-4 py-2">{tenant.userCount}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => void bukaDetail(tenant.id)}
                      className="text-slate-900 underline"
                    >
                      Kelola
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {detail && (
          <section className="mt-6 rounded-lg border border-slate-300 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">
                  {detail.name}{' '}
                  <span className="font-mono text-sm text-slate-400">{detail.code}</span>
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Paket {detail.planCode} · dibuat {detail.createdAt.slice(0, 10)}
                  {detail.trialEndsAt && ` · uji coba sampai ${detail.trialEndsAt.slice(0, 10)}`}
                  {/*
                    Stempel waktu ini TIDAK dikosongkan saat tenant diaktifkan
                    kembali — riwayatnya dibutuhkan saat sengketa tagihan, dan
                    karena itu ditampilkan meski statusnya sekarang aktif.
                  */}
                  {detail.suspendedAt && ` · pernah ditangguhkan ${detail.suspendedAt.slice(0, 10)}`}
                  {detail.churnedAt && ` · diakhiri ${detail.churnedAt.slice(0, 10)}`}
                </p>
              </div>
              <button onClick={() => setDetail(null)} className="text-sm text-slate-500 underline">
                Tutup
              </button>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium">Status langganan</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CHURNED'] as const)
                  .filter((status) => status !== detail.status)
                  .map((status) => (
                    <button
                      key={status}
                      onClick={() => void ubahStatus(detail.id, status)}
                      disabled={busy}
                      className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                        status === 'SUSPENDED' || status === 'CHURNED'
                          ? 'border-rose-300 text-rose-700 hover:bg-rose-50'
                          : 'border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Jadikan {status}
                    </button>
                  ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Menangguhkan tidak menghapus apa pun. Pelanggan yang membayar
                tunggakannya menemukan seluruh datanya utuh, dan yang tidak
                kembali tetap berhak atas ekspor portabilitasnya.
              </p>
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium">Modul</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {detail.modules.map((modul) => (
                  <label
                    key={modul.code}
                    className="flex items-start gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={modul.enabled}
                      disabled={busy || modul.isCore}
                      onChange={(e) => void ubahModul(detail.id, modul.code, e.target.checked)}
                      className="mt-1"
                    />
                    <span className="flex-1">
                      {modul.name}
                      <span className="ml-2 font-mono text-xs text-slate-400">{modul.code}</span>
                      <span className="block text-xs text-slate-500">
                        {modul.isCore
                          ? 'inti — selalu aktif'
                          : modul.inPlan
                            ? `tier ${modul.tier} · termasuk paket`
                            : `tier ${modul.tier} · DI LUAR PAKET`}
                      </span>
                      {/*
                        Entitlement adalah irisan "aktif" dan "termasuk paket".
                        Tanpa kalimat ini, superuser yang melihat modul bercentang
                        tidak akan mengerti mengapa pelanggannya tetap ditolak 402.
                      */}
                      {modul.enabled && !modul.inPlan && !modul.isCore && (
                        <span className="mt-1 block text-xs text-amber-700">
                          Aktif tetapi di luar paket — pelanggan tetap ditolak 402.
                          Naikkan paketnya lebih dulu.
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
