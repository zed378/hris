'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  colorSchemeDark,
  type CellValueChangedEvent,
  type ColDef,
} from 'ag-grid-community';
import { AppShell } from '@/components/app-shell.tsx';
import { useSession } from '@/lib/session.tsx';

/**
 * Grid karyawan ala Excel (PLAN/12 F2, risiko R6).
 *
 * Risiko R6 menyatakannya tanpa berputar: adopsi gagal bila UI terasa lebih
 * rumit daripada Excel. HR yang hari ini memperbarui lima puluh departemen
 * dengan satu tempel tidak akan pindah ke sistem yang menuntut lima puluh
 * formulir, dan tidak ada pelatihan yang mengubah itu. Halaman ini ada supaya
 * kebiasaan itu tetap berlaku di dalam sistem, bukan di luar.
 *
 * Empat hal yang menentukan apakah halaman ini benar-benar dipakai:
 *
 *   1. **Tempel dari Excel bekerja** — termasuk banyak baris sekaligus, dengan
 *      pemisah tab, dari clipboard sistem.
 *   2. **Perubahan tidak langsung tersimpan.** Yang disunting menumpuk sebagai
 *      draf sampai ditekan simpan. Menyimpan per sel akan menghasilkan ratusan
 *      permintaan saat menempel, dan membuat "batal" mustahil.
 *   3. **Kegagalan per baris terlihat di barisnya**, bukan sebagai satu pesan
 *      merah di atas. Tempelan dua ratus baris yang gagal seluruhnya karena satu
 *      sel akan mengembalikan orang ke Excel.
 *   4. **Kolom PII tidak dapat disunting bila nilainya tersamar.** Menyunting
 *      `••••1234` akan menyimpan tanda titik itu sebagai nomor rekening.
 */

// AG Grid 33+ menuntut modul didaftarkan eksplisit. Tanpa ini gridnya kosong
// tanpa satu pun galat di konsol.
ModuleRegistry.registerModules([AllCommunityModule]);

interface Row {
  id: string;
  version: number;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  department: string | null;
  position: string | null;
  pii: { nationalId: string | null; taxId: string | null; bankAccount: string | null };
  /** Diisi setelah simpan gagal. Ditampilkan pada barisnya. */
  saveError?: string | null;
}

type Draft = Record<string, Partial<Record<keyof Row | 'nationalId' | 'taxId' | 'bankAccount', unknown>>>;

const STATUSES = ['PROBATION', 'ACTIVE', 'RESIGNED', 'TERMINATED'];
const PAGE_SIZE = 200;

export default function EmployeeGridPage() {
  const { api, can } = useSession();
  const canUnmask = can('employee.pii.unmask');
  const canEdit = can('employee.employee.update');

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<{ saved: number; failed: number } | null>(null);
  const draft = useRef<Draft>({});
  const [dirtyCount, setDirtyCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    draft.current = {};
    setDirtyCount(0);
    setSummary(null);

    const response = await api(`/api/employees?limit=${PAGE_SIZE}`);
    if (response.ok) {
      const json = (await response.json()) as { employees: Row[] };
      setRows(json.employees.map((row) => ({ ...row, saveError: null })));
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCellValueChanged = useCallback((event: CellValueChangedEvent<Row>) => {
    const field = event.colDef.field;
    if (!field || !event.data) return;

    const entry = (draft.current[event.data.id] ??= {});
    entry[field as keyof typeof entry] = event.newValue;
    setDirtyCount(Object.keys(draft.current).length);
  }, []);

  const save = useCallback(async () => {
    const changes = Object.entries(draft.current).map(([id, fields]) => {
      const row = rows.find((candidate) => candidate.id === id);
      return { id, version: row?.version ?? 0, fields };
    });
    if (changes.length === 0) return;

    setSaving(true);
    const response = await api('/api/employees/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ changes }),
    });

    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setSummary({ saved: 0, failed: changes.length });
      setRows((current) =>
        current.map((row) =>
          draft.current[row.id]
            ? { ...row, saveError: json?.error?.message ?? 'Gagal disimpan' }
            : row,
        ),
      );
      setSaving(false);
      return;
    }

    const result = (await response.json()) as {
      saved: number;
      failed: number;
      rows: Array<{ id: string; ok: boolean; version: number | null; error: string | null }>;
    };

    // Baris yang berhasil membuang drafnya dan menerima versi baru; baris yang
    // gagal MENAHAN drafnya, supaya pekerjaan orang tidak hilang saat ia
    // memperbaiki satu sel yang salah.
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    for (const [id, outcome] of byId) if (outcome.ok) delete draft.current[id];

    setRows((current) =>
      current.map((row) => {
        const outcome = byId.get(row.id);
        if (!outcome) return row;
        return {
          ...row,
          ...(outcome.version !== null ? { version: outcome.version } : {}),
          saveError: outcome.error,
        };
      }),
    );

    setDirtyCount(Object.keys(draft.current).length);
    setSummary({ saved: result.saved, failed: result.failed });
    setSaving(false);
  }, [api, rows]);

  const columns = useMemo<ColDef<Row>[]>(() => {
    /**
     * Kolom PII hanya dapat disunting bila pengguna berhak melihat nilai aslinya.
     *
     * Tanpa penjaga ini, menyunting sel bernilai `••••1234` akan menyimpan tanda
     * titik itu sebagai nomor rekening — dan tidak ada yang menyadarinya sampai
     * transfer gaji gagal.
     */
    const pii = (
      field: 'nationalId' | 'taxId' | 'bankAccount',
      header: string,
    ): ColDef<Row> => ({
      field: field as never,
      headerName: canUnmask ? header : `${header} (tersamar)`,
      editable: canEdit && canUnmask,
      valueGetter: (params) => params.data?.pii[field] ?? '',
      ...(canUnmask ? {} : { cellClass: 'opacity-60' }),
      width: 160,
    });

    return [
      { field: 'employeeNumber', headerName: 'No. Karyawan', editable: canEdit, width: 140, pinned: 'left' },
      { field: 'fullName', headerName: 'Nama Lengkap', editable: canEdit, width: 220, pinned: 'left' },
      { field: 'email', headerName: 'Email', editable: canEdit, width: 220 },
      { field: 'phone', headerName: 'Telepon', editable: canEdit, width: 140 },
      {
        field: 'status',
        headerName: 'Status',
        editable: canEdit,
        width: 140,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: STATUSES },
      },
      // Departemen dan posisi berasal dari penempatan berperiode (P13), bukan
      // kolom pada karyawan. Menyuntingnya di sini akan menimpa riwayat, jadi
      // keduanya hanya ditampilkan.
      { field: 'department', headerName: 'Departemen', editable: false, width: 160 },
      { field: 'position', headerName: 'Jabatan', editable: false, width: 160 },
      pii('nationalId', 'NIK'),
      pii('taxId', 'NPWP'),
      pii('bankAccount', 'Rekening'),
      {
        field: 'saveError',
        headerName: 'Catatan',
        editable: false,
        width: 260,
        cellStyle: (params) => (params.value ? { color: '#b45309' } : undefined),
      },
    ];
  }, [canEdit, canUnmask]);

  // Tema mengikuti preferensi sistem. Dibaca sekali saat pemasangan: AG Grid
  // membangun ulang seluruh grid ketika temanya berganti, dan grid yang sedang
  // disunting akan kehilangan sel yang sedang terbuka.
  const theme = useMemo(() => {
    const dark =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? themeQuartz.withPart(colorSchemeDark) : themeQuartz;
  }, []);

  return (
    <AppShell>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Grid Karyawan</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Sunting seperti di Excel: klik sel, ketik, atau tempel beberapa baris
            sekaligus dengan Ctrl+V. Perubahan disimpan saat Anda menekan Simpan.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            disabled={saving}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Muat ulang
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || dirtyCount === 0 || !canEdit}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {saving
              ? 'Menyimpan…'
              : dirtyCount > 0
                ? `Simpan ${dirtyCount} baris`
                : 'Tidak ada perubahan'}
          </button>
        </div>
      </header>

      {!canEdit && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          Anda hanya dapat melihat. Penyuntingan membutuhkan izin ubah data karyawan.
        </p>
      )}

      {canEdit && !canUnmask && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          Kolom NIK, NPWP, dan rekening ditampilkan tersamar dan tidak dapat
          disunting. Menyunting nilai tersamar akan menyimpan tanda titiknya.
        </p>
      )}

      {summary && (
        <p
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            summary.failed > 0
              ? 'border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
          }`}
        >
          {summary.saved} baris tersimpan
          {summary.failed > 0 &&
            `, ${summary.failed} gagal. Alasannya ada di kolom Catatan pada barisnya, dan perubahan Anda masih tersimpan di layar.`}
        </p>
      )}

      <div style={{ height: 'calc(100vh - 320px)', minHeight: 420 }}>
        <AgGridReact<Row>
          theme={theme}
          rowData={loading ? [] : rows}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          onCellValueChanged={onCellValueChanged}
          // Tempel dari clipboard adalah inti halaman ini, bukan pelengkap.
          enableCellTextSelection
          suppressClipboardPaste={!canEdit}
          rowSelection={{ mode: 'multiRow', headerCheckbox: false }}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          overlayNoRowsTemplate={
            loading ? 'Memuat…' : 'Belum ada karyawan. Impor dari Excel terlebih dahulu.'
          }
        />
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Menampilkan {rows.length} karyawan pertama. Perubahan disimpan per baris —
        baris yang gagal tidak membatalkan baris yang berhasil.
      </p>
    </AppShell>
  );
}
