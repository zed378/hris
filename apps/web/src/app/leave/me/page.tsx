'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';
import { subscribeToPush, type PushOutcome } from '@/lib/push.ts';

/**
 * Cuti saya — saldo dan pengajuan (PLAN/12 F4).
 *
 * Saldo ditampilkan dengan komponennya terpisah, bukan hanya angka tersedia.
 * "Sisa cuti Anda 4 hari" tidak dapat ditindaklanjuti ketika seseorang yakin
 * seharusnya 6; "jatah 12, terpakai 6, ditahan 2" dapat.
 *
 * Kolom **ditahan** adalah yang paling sering menimbulkan pertanyaan, dan
 * karena itu diberi penjelasan di layar alih-alih dibiarkan sebagai istilah:
 * pengajuan yang belum diputuskan sudah mengurangi saldo tersedia, supaya
 * seseorang tidak dapat mengajukan tiga cuti di atas jatah satu.
 */

interface Balance {
  id: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  entitledDays: number;
  carriedOverDays: number;
  adjustmentDays: number;
  usedDays: number;
  pendingDays: number;
  availableDays: number;
}

interface LeaveType {
  id: string;
  code: string;
  name: string;
  requiresAttachment: boolean;
  deductFromBalance: boolean;
  minServiceMonths: number;
  colorHex: string;
}

interface Request {
  id: string;
  requestNumber: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: string;
  decidedAt: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draf',
  PENDING: 'Menunggu persetujuan',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  CANCELLED: 'Dibatalkan',
  TAKEN: 'Sudah diambil',
};

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  CANCELLED: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const FIELD =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MyLeavePage() {
  const { api } = useSession();

  const [balances, setBalances] = useState<Balance[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [approvers, setApprovers] = useState<
    Array<{ id: string; label: string; isManager: boolean }>
  >([]);
  const [managerDesignated, setManagerDesignated] = useState(true);

  const [push, setPush] = useState<PushOutcome | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  const [lampiran, setLampiran] = useState<{
    storageKey: string;
    fileName: string;
    sizeBytes: number;
  } | null>(null);
  const [unggahBusy, setUnggahBusy] = useState(false);
  const [unggahError, setUnggahError] = useState<string | null>(null);

  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: today(),
    endDate: today(),
    reason: '',
    approverId: '',
    attachmentKey: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [balanceRes, typeRes, requestRes, userRes] = await Promise.all([
      api('/api/leave/balances'),
      api('/api/leave/types'),
      api('/api/leave/requests'),
      api('/api/leave/approvers'),
    ]);

    if (balanceRes.ok) setBalances(((await balanceRes.json()) as { balances: Balance[] }).balances);
    if (typeRes.ok) {
      const json = (await typeRes.json()) as { types: LeaveType[] };
      setTypes(json.types);
      setForm((f) => (f.leaveTypeId ? f : { ...f, leaveTypeId: json.types[0]?.id ?? '' }));
    }
    if (requestRes.ok) setRequests(((await requestRes.json()) as { requests: Request[] }).requests);
    if (userRes.ok) {
      /**
       * Only users who can actually approve, with the line manager first.
       *
       * This used to read `/api/users`, which lists everyone. Nominating a
       * colleague without the approval permission was accepted everywhere and
       * silently produced a request that appeared in nobody's inbox.
       */
      const json = (await userRes.json()) as {
        approvers: Array<{ id: string; label: string; isManager: boolean }>;
        managerDesignated: boolean;
      };
      setApprovers(json.approvers);
      setManagerDesignated(json.managerDesignated);

      // The manager is PRESELECTED, not imposed. An existing choice is never
      // overwritten — reloading the list mid-form must not silently change who
      // the request is addressed to.
      const manager = json.approvers.find((a) => a.isManager);
      if (manager) setForm((f) => (f.approverId ? f : { ...f, approverId: manager.id }));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedType = useMemo(
    () => types.find((type) => type.id === form.leaveTypeId),
    [types, form.leaveTypeId],
  );

  /**
   * Mengunggah lampiran, lalu menyimpan kuncinya.
   *
   * Unggah mendahului pengajuan karena pengunggahnya belum tahu id pengajuannya.
   * Kuncinya disimpan di form dan diklaim server saat pengajuan dibuat — server
   * memeriksa bahwa berkas itu ada, milik pengaju, dan belum dipakai pengajuan
   * lain.
   */
  /**
   * Menyalakan notifikasi untuk perangkat ini.
   *
   * Ditawarkan di halaman cuti, bukan di halaman setelan, karena di sinilah
   * orang benar-benar menunggu kabar — dan permintaan izin yang muncul saat
   * seseorang sedang menunggu jawaban jauh lebih mungkin diterima daripada yang
   * muncul saat ia sedang mengerjakan hal lain.
   *
   * Izin notifikasi hanya dapat diminta SEKALI oleh peramban. Setelah ditolak,
   * dialognya tidak akan muncul lagi.
   */
  const nyalakanNotifikasi = useCallback(async () => {
    setPushBusy(true);
    setPush(await subscribeToPush(api));
    setPushBusy(false);
  }, [api]);

  const unggahLampiran = useCallback(
    async (file: File) => {
      setUnggahBusy(true);
      setUnggahError(null);

      const body = new FormData();
      body.append('file', file);

      // `content-type` sengaja tidak dipasang: peramban yang menentukannya
      // sendiri beserta boundary multipart-nya, dan memasangnya manual
      // menghasilkan badan yang tidak dapat diurai server.
      const response = await api('/api/leave/attachments', { method: 'POST', body });

      if (response.ok) {
        const json = (await response.json()) as {
          storageKey: string;
          fileName: string;
          sizeBytes: number;
        };
        setLampiran(json);
        setForm((f) => ({ ...f, attachmentKey: json.storageKey }));
      } else {
        const json = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setUnggahError(json?.error?.message ?? 'Unggahan gagal.');
        setLampiran(null);
        setForm((f) => ({ ...f, attachmentKey: '' }));
      }
      setUnggahBusy(false);
    },
    [api],
  );

  const submit = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const response = await api('/api/leave/requests', {
      method: 'POST',
      body: JSON.stringify({
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        isHalfDay: false,
        reason: form.reason.trim(),
        approverId: form.approverId,
        ...(form.attachmentKey ? { attachmentKey: form.attachmentKey } : {}),
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as Request;
      setMessage({
        tone: 'ok',
        text: `${json.requestNumber} diajukan — ${json.totalDays} hari kerja, menunggu persetujuan.`,
      });
      setForm((f) => ({ ...f, reason: '', attachmentKey: '' }));
      setLampiran(null);
      void load();
    } else {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage({ tone: 'error', text: json?.error?.message ?? 'Pengajuan gagal.' });
    }
    setBusy(false);
  }, [api, form, load]);

  const cancel = useCallback(
    async (id: string, nomor: string) => {
      if (!window.confirm(`Batalkan ${nomor}?`)) return;
      const response = await api(`/api/leave/requests/${id}/decision`, { method: 'DELETE' });
      setMessage(
        response.ok
          ? { tone: 'ok', text: `${nomor} dibatalkan, saldonya dilepaskan.` }
          : { tone: 'error', text: 'Pembatalan gagal.' },
      );
      void load();
    },
    [api, load],
  );

  const canSubmit =
    form.leaveTypeId !== '' &&
    form.approverId !== '' &&
    form.reason.trim().length >= 4 &&
    !busy &&
    (!selectedType?.requiresAttachment || form.attachmentKey.trim() !== '');

  return (
    <AppShell>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Cuti Saya</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Akhir pekan dan hari libur nasional tidak dihitung sebagai hari cuti.
        </p>
      </header>

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((balance) => (
          <div
            key={balance.id}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <p className="text-sm font-medium">{balance.leaveTypeName}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {balance.availableDays}
              <span className="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">
                hari tersedia
              </span>
            </p>
            <dl className="mt-2 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex justify-between">
                <dt>Jatah tahun ini</dt>
                <dd className="tabular-nums">{balance.entitledDays}</dd>
              </div>
              {balance.carriedOverDays > 0 && (
                <div className="flex justify-between">
                  <dt>Sisa tahun lalu</dt>
                  <dd className="tabular-nums">{balance.carriedOverDays}</dd>
                </div>
              )}
              {balance.adjustmentDays !== 0 && (
                <div className="flex justify-between">
                  <dt>Penyesuaian HR</dt>
                  <dd className="tabular-nums">{balance.adjustmentDays}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt>Terpakai</dt>
                <dd className="tabular-nums">−{balance.usedDays}</dd>
              </div>
              {balance.pendingDays > 0 && (
                <div
                  className="flex justify-between text-amber-700 dark:text-amber-300"
                  title="Pengajuan yang belum diputuskan sudah mengurangi saldo tersedia, supaya Anda tidak dapat mengajukan lebih dari jatah."
                >
                  <dt>Ditahan pengajuan</dt>
                  <dd className="tabular-nums">−{balance.pendingDays}</dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </section>

      {/*
        Ditawarkan sekali, dan hanya sampai berhasil. Tombol yang tetap muncul
        setelah notifikasi menyala adalah tombol yang ditekan orang untuk
        memastikan — lalu `subscribe()` mengembalikan langganan yang sama dan
        tidak terjadi apa-apa, yang terbaca sebagai kerusakan.
      */}
      {!push?.ok && (
        <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Notifikasi keputusan cuti</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Dapatkan pemberitahuan di perangkat ini begitu pengajuan Anda
                diputuskan, tanpa perlu membuka halaman ini berulang kali.
              </p>
            </div>
            <button
              onClick={() => void nyalakanNotifikasi()}
              disabled={pushBusy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {pushBusy ? 'Menyiapkan…' : 'Nyalakan'}
            </button>
          </div>

          {push && !push.ok && (
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {push.message}
            </p>
          )}
        </section>
      )}

      {push?.ok && (
        <p className="mb-5 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Notifikasi menyala di perangkat ini. Ia berhenti otomatis saat Anda keluar.
        </p>
      )}

      <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">Ajukan cuti</h2>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select
            value={form.leaveTypeId}
            onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))}
            className={FIELD}
          >
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={form.startDate}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                startDate: e.target.value,
                // Tanggal selesai mengikuti bila ia jadi mendahului tanggal mulai.
                endDate: f.endDate < e.target.value ? e.target.value : f.endDate,
              }))
            }
            className={FIELD}
          />

          <input
            type="date"
            value={form.endDate}
            min={form.startDate}
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            className={FIELD}
          />

          <select
            value={form.approverId}
            onChange={(e) => setForm((f) => ({ ...f, approverId: e.target.value }))}
            className={FIELD}
          >
            <option value="">Pilih penyetuju…</option>
            {approvers.map((approver) => (
              <option key={approver.id} value={approver.id}>
                {approver.label}
                {approver.isManager ? ' — atasan langsung' : ''}
              </option>
            ))}
          </select>
        </div>

        {approvers.length === 0 ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Belum ada pengguna yang berwenang menyetujui cuti. Minta admin memberi
            izin persetujuan cuti kepada minimal satu orang — tanpa itu pengajuan
            tidak dapat diputuskan siapa pun.
          </p>
        ) : (
          !managerDesignated && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Atasan langsung Anda belum ditetapkan, jadi penyetuju harus dipilih
              sendiri. Admin dapat menetapkannya pada data penempatan.
            </p>
          )
        )}

        <input
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          placeholder="Alasan cuti (minimal 4 karakter)"
          className={`mt-2 w-full ${FIELD}`}
        />

        {selectedType?.requiresAttachment && (
          <div className="mt-2">
            {/*
              Berkas, bukan teks bebas.

              Sebelumnya kotak ini menerima ketikan apa pun — sehingga syarat
              "wajib melampirkan surat dokter" dipenuhi dengan mengetik kata
              "ada". Untuk cuti sakit, surat dokter itulah satu-satunya hal yang
              membedakan cuti berbayar dari mangkir.
            */}
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void unggahLampiran(file);
              }}
              disabled={unggahBusy}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-slate-800"
            />
            <p className="mt-1 text-xs text-slate-500">
              {unggahBusy
                ? 'Mengunggah…'
                : lampiran
                  ? `Terlampir: ${lampiran.fileName} (${Math.round(lampiran.sizeBytes / 1024)} KB)`
                  : 'PDF, JPG, PNG, atau WebP — maksimal 5 MB. Wajib untuk jenis cuti ini.'}
            </p>
            {unggahError && (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{unggahError}</p>
            )}
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Mengirim…' : 'Ajukan'}
          </button>
          {selectedType && !selectedType.deductFromBalance && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Jenis ini tidak memotong saldo cuti tahunan Anda.
            </span>
          )}
        </div>

        {message && (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      {requests.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Belum ada pengajuan cuti.
        </p>
      ) : (
        <div className="space-y-2">
          {requests.map((request) => (
            <article
              key={request.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {request.leaveTypeName}{' '}
                  <span className="font-mono text-xs text-slate-400">{request.requestNumber}</span>
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {request.startDate} – {request.endDate} · {request.totalDays} hari kerja ·{' '}
                  {request.reason}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    STATUS_TONE[request.status] ??
                    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                  }`}
                >
                  {STATUS_LABEL[request.status] ?? request.status}
                </span>
                {request.status === 'PENDING' && (
                  <button
                    onClick={() => void cancel(request.id, request.requestNumber)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Batalkan
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
