import { workerClient } from '@hrms/db';

/**
 * Pemeriksaan drift skema harian (PLAN/12 F6 — pengerasan).
 *
 * Ada gerbang CI yang memeriksa hal yang sama, dan gerbang itu tidak cukup.
 * CI melihat skema yang DIBANGUN DARI MIGRASI; yang dijaga job ini adalah
 * basis data produksi yang sebenarnya.
 *
 * Perbedaannya muncul pada malam insiden: seseorang menambahkan tabel lewat
 * psql untuk menyelesaikan masalah, atau sebuah migrasi gagal separuh jalan dan
 * meninggalkan tabel tanpa kebijakannya. Keduanya menghasilkan keadaan yang
 * tidak akan pernah terlihat oleh CI mana pun, karena tidak ada satu pun
 * migrasi yang menggambarkannya.
 *
 * Yang paling berbahaya di antaranya — tabel ber-`tenant_id` tanpa RLS — berarti
 * setiap tenant membaca data seluruh tenant lain. Ia tidak menghasilkan galat,
 * tidak memperlambat apa pun, dan tidak ada yang menyadarinya sampai seseorang
 * melihat data yang bukan miliknya.
 */

export interface DriftFinding {
  kind: string;
  objectName: string;
  detail: string;
}

export interface DriftResult {
  findings: DriftFinding[];
  checkedAt: string;
}

export async function runSchemaDriftCheck(): Promise<DriftResult> {
  const rows = await workerClient().$queryRaw<
    Array<{ kind: string; object_name: string; detail: string }>
  >`SELECT kind, object_name, detail FROM public.schema_drift_report()`;

  const findings = rows.map((row) => ({
    kind: row.kind,
    objectName: row.object_name,
    detail: row.detail,
  }));

  if (findings.length > 0) {
    // `error`, bukan `warn`. Temuan di sini berarti isolasi tenant sedang
    // bocor atau sebuah modul sedang mati total — keduanya adalah insiden,
    // bukan catatan yang menunggu ditinjau minggu depan.
    console.error({
      scope: 'schema-drift',
      severity: 'critical',
      count: findings.length,
      findings,
    });
  } else {
    console.log({ scope: 'schema-drift', status: 'bersih' });
  }

  return { findings, checkedAt: new Date().toISOString() };
}
