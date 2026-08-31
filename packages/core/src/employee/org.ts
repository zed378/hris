import { writeAudit, type TenantClient } from '@hrms/db';
import type { ActorContext } from './employees.ts';

/**
 * Struktur organisasi dan penempatan karyawan.
 *
 * Dua hal yang membentuk modul ini:
 *
 * **Departemen memakai jalur termaterialisasi.** Kolom `path` menyimpan garis
 * keturunan lengkap ("/ops/hr/recruit"), sehingga "seluruh bawahan departemen X"
 * menjadi satu `LIKE 'X/%'` alih-alih rekursi. Harganya: memindahkan departemen
 * berarti menulis ulang path seluruh keturunannya — operasi yang jarang, dan
 * itulah pertukaran yang dipilih.
 *
 * **Penempatan tidak pernah ditimpa** (P13). Mutasi menutup periode berjalan
 * dengan `effectiveTo` dan membuka baris baru. Pertanyaan "siapa kepala
 * departemen ini bulan Maret lalu" karenanya tetap dapat dijawab tahun depan —
 * dan pertanyaan itu muncul setiap kali ada sengketa.
 */

export class OrgError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
    this.name = 'OrgError';
  }
}

// -----------------------------------------------------------------------------
// Departemen
// -----------------------------------------------------------------------------

export interface DepartmentNode {
  id: string;
  code: string;
  name: string;
  path: string;
  parentId: string | null;
  isActive: boolean;
  headcount: number;
  children: DepartmentNode[];
}

export async function listDepartments(
  tx: TenantClient,
  tenantId: string,
): Promise<DepartmentNode[]> {
  const rows = await tx.department.findMany({
    where: { tenantId },
    orderBy: { path: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      path: true,
      parentId: true,
      isActive: true,
      _count: { select: { employments: { where: { effectiveTo: null } } } },
    },
  });

  const byId = new Map<string, DepartmentNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      code: row.code,
      name: row.name,
      path: row.path,
      parentId: row.parentId,
      isActive: row.isActive,
      headcount: row._count.employments,
      children: [],
    });
  }

  const roots: DepartmentNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

export async function createDepartment(
  tx: TenantClient,
  tenantId: string,
  input: { code: string; name: string; parentId?: string | null | undefined },
  ctx: ActorContext,
): Promise<{ id: string; path: string }> {
  const code = input.code.trim().toLowerCase();

  let parentPath = '';
  if (input.parentId) {
    const parent = await tx.department.findFirst({
      where: { id: input.parentId, tenantId },
      select: { path: true },
    });
    if (!parent) throw new OrgError('Departemen induk tidak ditemukan', 'not_found');
    parentPath = parent.path;
  }

  const path = `${parentPath}/${code}`;

  const created = await tx.department.create({
    data: {
      tenantId,
      code,
      name: input.name.trim(),
      parentId: input.parentId ?? null,
      path,
    },
    select: { id: true, path: true },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.department.created',
    entityType: 'department',
    entityId: created.id,
    actorUserId: ctx.actorUserId,
    after: { code, name: input.name, path },
    ip: ctx.ip,
    correlationId: ctx.correlationId,
  });

  return created;
}

// -----------------------------------------------------------------------------
// Jabatan
// -----------------------------------------------------------------------------

export async function listPositions(
  tx: TenantClient,
  tenantId: string,
): Promise<Array<{ id: string; code: string; name: string; level: number; headcount: number }>> {
  const rows = await tx.position.findMany({
    where: { tenantId },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      level: true,
      _count: { select: { employments: { where: { effectiveTo: null } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    level: row.level,
    headcount: row._count.employments,
  }));
}

export async function createPosition(
  tx: TenantClient,
  tenantId: string,
  input: { code: string; name: string; level?: number },
  ctx: ActorContext,
): Promise<{ id: string }> {
  const created = await tx.position.create({
    data: {
      tenantId,
      code: input.code.trim().toLowerCase(),
      name: input.name.trim(),
      level: input.level ?? 0,
    },
    select: { id: true },
  });

  await writeAudit(tx, tenantId, {
    action: 'employee.position.created',
    entityType: 'position',
    entityId: created.id,
    actorUserId: ctx.actorUserId,
    after: { code: input.code, name: input.name },
    ip: ctx.ip,
    correlationId: ctx.correlationId,
  });

  return created;
}

// -----------------------------------------------------------------------------
// Penempatan
// -----------------------------------------------------------------------------

export interface PlacementInput {
  employeeId: string;
  departmentId: string;
  positionId: string;
  type: 'PKWTT' | 'PKWT' | 'MAGANG' | 'HARIAN' | 'BORONGAN';
  effectiveFrom: Date;
  managerId?: string | null | undefined;
}

/**
 * Menempatkan atau memutasi karyawan.
 *
 * Satu transaksi yang menutup periode berjalan dan membuka yang baru. Indeks
 * unik parsial `employments_one_open_per_employee` menjamin tepat satu penempatan
 * terbuka per karyawan — sehingga mutasi yang gagal di tengah tidak dapat
 * meninggalkan dua baris terbuka, dan pertanyaan "di departemen mana orang ini
 * sekarang" tidak pernah punya dua jawaban.
 *
 * `effectiveTo` periode lama diisi H-1 dari `effectiveFrom` yang baru, bukan
 * tanggal yang sama. Dua periode yang berbagi satu hari akan membuat laporan
 * headcount harian menghitung orang itu dua kali.
 */
export async function placeEmployee(
  tx: TenantClient,
  tenantId: string,
  input: PlacementInput,
  ctx: ActorContext,
): Promise<{ id: string; closedPrevious: boolean }> {
  const [employee, department, position] = await Promise.all([
    tx.employee.findFirst({ where: { id: input.employeeId, tenantId }, select: { id: true } }),
    tx.department.findFirst({ where: { id: input.departmentId, tenantId }, select: { id: true } }),
    tx.position.findFirst({ where: { id: input.positionId, tenantId }, select: { id: true } }),
  ]);

  if (!employee) throw new OrgError('Karyawan tidak ditemukan', 'not_found');
  if (!department) throw new OrgError('Departemen tidak ditemukan', 'not_found');
  if (!position) throw new OrgError('Jabatan tidak ditemukan', 'not_found');

  /**
   * The manager is checked, now that something reads the column.
   *
   * `managerId` is a soft reference — no foreign key, because employee and
   * attendance are meant to be separable (PLAN/01 §4.2) — and for as long as
   * nothing read it, an id pointing nowhere was merely untidy. It is now the
   * default approver for that person's leave, so a wrong id no longer sits
   * still: it silently means "this employee has no manager", and the difference
   * between a manager who was never set and one whose id is wrong is invisible
   * from every screen.
   *
   * Self-management is refused for the same reason a requester cannot approve
   * their own leave (control failure 39). Left permitted, it would preselect the
   * requester as their own approver and the request would be refused a screen
   * later, with nothing explaining why.
   */
  if (input.managerId) {
    if (input.managerId === input.employeeId) {
      throw new OrgError('Karyawan tidak dapat menjadi atasan langsung dirinya sendiri', 'invalid');
    }

    const manager = await tx.employee.findFirst({
      where: { id: input.managerId, tenantId },
      select: { id: true },
    });
    if (!manager) throw new OrgError('Atasan langsung tidak ditemukan', 'not_found');
  }

  const current = await tx.employment.findFirst({
    where: { tenantId, employeeId: input.employeeId, effectiveTo: null },
    select: { id: true, effectiveFrom: true },
  });

  if (current && current.effectiveFrom >= input.effectiveFrom) {
    throw new OrgError(
      'Tanggal mutasi harus setelah tanggal penempatan yang sedang berjalan.',
      'invalid',
    );
  }

  if (current) {
    const dayBefore = new Date(input.effectiveFrom.getTime() - 86_400_000);
    await tx.employment.update({
      where: { id: current.id },
      data: { effectiveTo: dayBefore },
    });
  }

  const created = await tx.employment.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      departmentId: input.departmentId,
      positionId: input.positionId,
      type: input.type,
      effectiveFrom: input.effectiveFrom,
      managerId: input.managerId ?? null,
    },
    select: { id: true },
  });

  await writeAudit(tx, tenantId, {
    action: current ? 'employee.transferred' : 'employee.placed',
    entityType: 'employee',
    entityId: input.employeeId,
    actorUserId: ctx.actorUserId,
    after: {
      departmentId: input.departmentId,
      positionId: input.positionId,
      effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
    },
    ip: ctx.ip,
    correlationId: ctx.correlationId,
  });

  return { id: created.id, closedPrevious: current !== null };
}

/** Riwayat penempatan seorang karyawan, terbaru lebih dulu. */
export async function placementHistory(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
): Promise<
  Array<{
    id: string;
    department: string;
    position: string;
    type: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>
> {
  const rows = await tx.employment.findMany({
    where: { tenantId, employeeId },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      id: true,
      type: true,
      effectiveFrom: true,
      effectiveTo: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    department: row.department.name,
    position: row.position.name,
    type: row.type,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: row.effectiveTo?.toISOString().slice(0, 10) ?? null,
  }));
}
