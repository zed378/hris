'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Pengguna dan hak aksesnya (PLAN/05 §4).
 *
 * Menu "Pengguna" sudah ada di basis data sejak seed pertama dan tampil bagi
 * setiap pemilik tenant yang membuka sidebar — menuju halaman yang tidak pernah
 * ada. Endpoint-nya lengkap sejak Fase 1; yang tidak ada hanyalah layarnya.
 *
 * Akibatnya bukan ketidaknyamanan. **Pemilik tenant yang baru mendaftar tidak
 * dapat menambahkan satu orang pun.** Ia mendaftar sendiri, mendapat akun
 * pemilik, lalu berhenti di situ: tidak ada cara mengundang HR-nya, tidak ada
 * cara memberi manajer hak menyetujui cuti, tidak ada cara mencabut akses orang
 * yang keluar. Seluruh cerita IAM — peran, hak per-pengguna, DENY yang menang
 * atas segalanya — hanya dapat dijalankan lewat `curl`.
 *
 * Itu memblokir Gerbang A secara langsung: tiga pilot yang melakukan onboarding
 * mandiri tidak dapat melakukannya bila perusahaan mereka hanya boleh punya satu
 * akun.
 */

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  lastLoginAt: string | null;
}

interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

interface PermissionRow {
  code: string;
  moduleCode: string;
  description: string | null;
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  INVITED: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  SUSPENDED: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const FIELD =
  'rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

export default function UsersPage() {
  const { api, can } = useSession();
  const canInvite = can('iam.user.create');
  const canGrant = can('iam.grant.manage');

  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [invite, setInvite] = useState({ email: '', fullName: '', roleCode: '' });
  const [busy, setBusy] = useState(false);

  const [massalBusy, setMassalBusy] = useState(false);
  const [grantFor, setGrantFor] = useState<UserRow | null>(null);
  const [grant, setGrant] = useState({
    permissionCode: '',
    effect: 'DENY' as 'GRANT' | 'DENY',
    reason: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [userRes, roleRes] = await Promise.all([api('/api/users'), api('/api/roles')]);
    if (userRes.ok) setUsers(((await userRes.json()) as { users: UserRow[] }).users);
    if (roleRes.ok) {
      const json = (await roleRes.json()) as { roles: Role[]; catalog: PermissionRow[] };
      setRoles(json.roles);
      setCatalog(json.catalog);
      setInvite((f) => (f.roleCode ? f : { ...f, roleCode: json.roles[0]?.code ?? '' }));
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const kirimUndangan = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const response = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify(invite),
    });

    if (response.ok) {
      setInvite((f) => ({ ...f, email: '', fullName: '' }));
      // Emailnya dikirim konsumer event, bukan di jalur permintaan ini —
      // penyedia email yang sedang bermasalah tidak membuat undangan gagal.
      // Karena itu kalimatnya menyebut "sedang dikirim", bukan "terkirim".
      setMessage({
        tone: 'ok',
        text: 'Undangan dibuat. Emailnya sedang dikirim di latar belakang.',
      });
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Undangan gagal dibuat.' });
    }
    setBusy(false);
  }, [api, invite, load]);

  /**
   * Mengundang seluruh karyawan yang belum punya akun.
   *
   * Tanpa ini, HR yang baru mengimpor 100 karyawan harus mengisi formulir di
   * atas seratus kali — dengan email dan nama yang sudah ada di baris
   * karyawannya. Sampai ia selesai, tidak satu pun dari seratus orang itu dapat
   * masuk, mengetuk presensi, atau melihat slip gajinya.
   */
  const undangMassal = useCallback(async () => {
    setMassalBusy(true);
    setMessage(null);

    const response = await api('/api/users/from-employees', {
      method: 'POST',
      body: JSON.stringify({ roleCode: 'EMPLOYEE' }),
    });

    if (response.ok) {
      const json = (await response.json()) as {
        invited: number;
        alreadyHasAccount: number;
        withoutEmail: Array<{ employeeNumber: string; fullName: string }>;
      };

      const bagian = [`${json.invited} karyawan diundang.`];
      if (json.alreadyHasAccount > 0) bagian.push(`${json.alreadyHasAccount} sudah punya akun.`);
      if (json.withoutEmail.length > 0) {
        // Disebut namanya, bukan hanya jumlahnya. "12 karyawan tanpa email"
        // tidak dapat ditindaklanjuti; nama dan nomornya dapat.
        const contoh = json.withoutEmail
          .slice(0, 5)
          .map((e) => `${e.employeeNumber} ${e.fullName}`)
          .join(', ');
        bagian.push(
          `${json.withoutEmail.length} belum punya email dan tidak dapat diundang: ${contoh}` +
            (json.withoutEmail.length > 5 ? ', …' : '') +
            '. Lengkapi kolom emailnya lebih dulu.',
        );
      }

      setMessage({ tone: json.withoutEmail.length > 0 ? 'error' : 'ok', text: bagian.join(' ') });
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Undangan massal gagal.' });
    }
    setMassalBusy(false);
  }, [api, load]);

  const simpanGrant = useCallback(async () => {
    if (!grantFor) return;
    setBusy(true);
    setMessage(null);

    const response = await api(`/api/users/${grantFor.id}/grants`, {
      method: 'PUT',
      body: JSON.stringify(grant),
    });

    if (response.ok) {
      setMessage({
        tone: 'ok',
        text:
          grant.effect === 'DENY'
            ? `Izin "${grant.permissionCode}" dicabut dari ${grantFor.fullName}. Berlaku seketika.`
            : `Izin "${grant.permissionCode}" diberikan kepada ${grantFor.fullName}.`,
      });
      setGrantFor(null);
      setGrant({ permissionCode: '', effect: 'DENY', reason: '' });
    } else {
      const json = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Perubahan hak akses gagal.' });
    }
    setBusy(false);
  }, [api, grant, grantFor]);

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Pengguna</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Setiap orang yang masuk ke sistem ini punya satu akun dan satu atau lebih
        peran. Hak akses berasal dari perannya; pengecualian per orang diatur
        terpisah di bawah.
      </p>

      {message && (
        <p
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200'
          }`}
        >
          {message.text}
        </p>
      )}

      {canInvite && (
        <section className="mt-6 max-w-3xl rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-lg font-medium">Undang pengguna</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <input
              value={invite.fullName}
              onChange={(e) => setInvite((f) => ({ ...f, fullName: e.target.value }))}
              placeholder="Nama lengkap"
              className={FIELD}
            />
            <input
              type="email"
              value={invite.email}
              onChange={(e) => setInvite((f) => ({ ...f, email: e.target.value }))}
              placeholder="email@perusahaan.co.id"
              className={FIELD}
            />
            <select
              value={invite.roleCode}
              onChange={(e) => setInvite((f) => ({ ...f, roleCode: e.target.value }))}
              className={FIELD}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.code}>
                  {role.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void kirimUndangan()}
              disabled={busy || invite.fullName.trim().length < 2 || !invite.email.includes('@')}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              Kirim undangan
            </button>
          </div>
          <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
            <button
              onClick={() => void undangMassal()}
              disabled={massalBusy}
              className="rounded-md border border-brand-600 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300 dark:hover:bg-slate-800"
            >
              {massalBusy ? 'Mengundang…' : 'Undang semua karyawan yang belum punya akun'}
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Memakai email dan nama dari data karyawan. Yang sudah punya akun
              dilewati; yang belum punya email disebutkan agar dapat dilengkapi.
            </p>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Pengguna dibuat berstatus <strong>INVITED</strong> dan belum dapat
            masuk sampai ia menetapkan kata sandinya sendiri lewat tautan
            undangan. Kata sandinya tidak pernah ditentukan siapa pun selain
            dirinya.
          </p>
        </section>
      )}

      <section className="mt-8">
        {loading ? (
          <p className="text-sm text-slate-500">Memuat…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2 pr-6">Nama</th>
                  <th className="py-2 pr-6">Email</th>
                  <th className="py-2 pr-6">Peran</th>
                  <th className="py-2 pr-6">Status</th>
                  <th className="py-2 pr-6">Terakhir masuk</th>
                  {canGrant && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-2 pr-6">{user.fullName}</td>
                    <td className="py-2 pr-6 text-slate-500">{user.email}</td>
                    <td className="py-2 pr-6">
                      {user.roles.length > 0 ? user.roles.join(', ') : '—'}
                    </td>
                    <td className="py-2 pr-6">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          STATUS_TONE[user.status] ?? STATUS_TONE['SUSPENDED']!
                        }`}
                      >
                        {user.status}
                      </span>
                    </td>
                    <td className="py-2 pr-6 text-slate-500">
                      {user.lastLoginAt ? user.lastLoginAt.slice(0, 10) : 'belum pernah'}
                    </td>
                    {canGrant && (
                      <td className="py-2">
                        <button
                          onClick={() => setGrantFor(user)}
                          className="text-sm text-brand-600 underline"
                        >
                          Hak khusus
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {grantFor && (
        <section className="mt-8 max-w-3xl rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-lg font-medium">
            Hak khusus untuk {grantFor.fullName}
          </h2>

          {/*
            DENY selalu menang atas peran maupun atas GRANT. Itulah yang membuat
            pencabutan darurat dapat diandalkan: tidak perlu menelusuri seluruh
            peran seseorang untuk memastikan sebuah izin benar-benar hilang.

            Dijelaskan di layar karena orang yang memakainya sedang terburu-buru
            — pencabutan darurat tidak dilakukan pada hari yang tenang.
          */}
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Pengecualian di luar peran. <strong>Penolakan selalu menang</strong> —
            atas peran maupun atas pemberian — sehingga mencabut satu izin di sini
            tidak menuntut penelusuran seluruh peran orang ini. Berlaku seketika,
            bukan setelah sesi berikutnya.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <select
              value={grant.permissionCode}
              onChange={(e) => setGrant((g) => ({ ...g, permissionCode: e.target.value }))}
              className={FIELD}
            >
              <option value="">Pilih izin…</option>
              {catalog.map((permission) => (
                <option key={permission.code} value={permission.code}>
                  {permission.code} — {permission.description ?? permission.moduleCode}
                </option>
              ))}
            </select>

            <select
              value={grant.effect}
              onChange={(e) =>
                setGrant((g) => ({ ...g, effect: e.target.value as 'GRANT' | 'DENY' }))
              }
              className={FIELD}
            >
              <option value="DENY">Tolak (menang atas peran)</option>
              <option value="GRANT">Beri (di luar peran)</option>
            </select>
          </div>

          {/*
            Alasan wajib, dan minimalnya sama dengan constraint basis datanya.
            Hak akses yang berubah tanpa alasan tertulis adalah hak akses yang
            tidak dapat ditinjau enam bulan kemudian — dan peninjauan itulah
            yang diminta auditor.
          */}
          <input
            value={grant.reason}
            onChange={(e) => setGrant((g) => ({ ...g, reason: e.target.value }))}
            placeholder="Alasan — wajib, minimal 8 karakter"
            className={`${FIELD} mt-3 w-full`}
          />

          <div className="mt-3 flex gap-3">
            <button
              onClick={() => void simpanGrant()}
              disabled={busy || !grant.permissionCode || grant.reason.trim().length < 8}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              Simpan
            </button>
            <button
              onClick={() => setGrantFor(null)}
              className="rounded-md px-4 py-2 text-sm text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Batal
            </button>
          </div>
        </section>
      )}
    </AppShell>
  );
}
