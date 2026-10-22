import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import { EventTopic } from '@hrms/contracts';
import { bumpAccessVersion } from './resolve-access.ts';
import { assertCanConfer } from './ceiling.ts';
import { IamError } from './errors.ts';

export { IamError };

/**
 * Antarmuka administrasi peran, hak akses khusus, dan pengguna (docs/PLAN/05 §7).
 *
 * Satu aturan mengikat setiap fungsi yang mengubah akses di berkas ini:
 * **perubahan hak akses dan kenaikan versi akses terjadi dalam transaksi yang
 * sama.**
 *
 * Bila dipisah, ada jendela di mana akses sudah berubah tetapi token lama masih
 * membawa versi lama, sehingga cache menyajikan izin yang sudah dicabut. Jendela
 * itu paling mungkin terbuka justru pada saat seseorang sedang mencabut akses
 * dengan tergesa — yaitu saat ia paling tidak boleh terbuka (docs/PLAN/05 §5.3).
 */

export interface ActorContext {
  actorUserId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

// -----------------------------------------------------------------------------
// Pengguna
// -----------------------------------------------------------------------------

export async function listUsers(
  tx: TenantClient,
  tenantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{
  users: Array<{
    id: string;
    email: string;
    fullName: string;
    status: string;
    roles: string[];
    lastLoginAt: string | null;
  }>;
  total: number;
}> {
  const [rows, total] = await Promise.all([
    tx.user.findMany({
      where: { tenantId },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        status: true,
        lastLoginAt: true,
        roles: { select: { role: { select: { code: true } } } },
      },
    }),
    tx.user.count({ where: { tenantId } }),
  ]);

  return {
    total,
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      status: u.status,
      roles: u.roles.map((r) => r.role.code).sort(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Membuat pengguna berstatus INVITED.
 *
 * Tanpa kata sandi — kata sandinya dipasang penerima undangan sendiri. Ini bukan
 * kenyamanan: kata sandi yang dibuatkan admin harus dikirimkan lewat suatu kanal,
 * dan kanal itu (email, WhatsApp, catatan tempel) menjadi tempat kata sandi
 * tersebut hidup lebih lama daripada seharusnya.
 */
export async function inviteUser(
  tx: TenantClient,
  tenantId: string,
  input: { email: string; fullName: string; roleCode: string },
  ctx: ActorContext,
): Promise<{ userId: string }> {
  const role = await findAssignableRole(tx, tenantId, input.roleCode, ctx.actorUserId);
  return createInvitedUser(tx, tenantId, role.id, input, ctx);
}

/**
 * The role an invitation would assign, once the permission ceiling allows it.
 *
 * Assigning a role confers every permission on it, so the whole role must be
 * within what the actor holds (P6-13). Separate from `createInvitedUser` so the
 * bulk invitation checks once per call rather than once per employee.
 */
export async function findAssignableRole(
  tx: TenantClient,
  tenantId: string,
  roleCode: string,
  actorUserId: string,
): Promise<{ id: string }> {
  const role = await tx.role.findUnique({
    where: { tenantId_code: { tenantId, code: roleCode } },
    select: { id: true, permissions: { select: { permissionCode: true } } },
  });
  if (!role) throw new IamError(`Peran "${roleCode}" tidak ditemukan`, 'not_found');

  await assertCanConfer(tx, tenantId, actorUserId, {
    permissions: role.permissions.map((p) => p.permissionCode),
    roleCode,
  });
  return { id: role.id };
}

/** Creates the INVITED user. The caller has already passed `findAssignableRole`. */
export async function createInvitedUser(
  tx: TenantClient,
  tenantId: string,
  roleId: string,
  input: { email: string; fullName: string; roleCode: string },
  ctx: ActorContext,
): Promise<{ userId: string }> {
  const existing = await tx.user.findUnique({
    where: { tenantId_email: { tenantId, email: input.email } },
    select: { id: true },
  });
  if (existing) throw new IamError('Email ini sudah terdaftar', 'conflict');

  const user = await tx.user.create({
    data: {
      tenantId,
      email: input.email,
      fullName: input.fullName,
      // Placeholder yang tidak dapat dicocokkan argon2 mana pun. Pengguna INVITED
      // juga sudah ditolak jalur login lewat pemeriksaan status.
      passwordHash: 'invited:no-password-set',
      status: 'INVITED',
    },
    select: { id: true },
  });

  await tx.userRole.create({
    data: { tenantId, userId: user.id, roleId, assignedBy: ctx.actorUserId },
  });
  await tx.accessVersion.create({ data: { tenantId, userId: user.id, version: 1 } });

  await writeAudit(tx, tenantId, {
    action: 'iam.user.invited',
    entityType: 'user',
    entityId: user.id,
    actorUserId: ctx.actorUserId,
    after: { email: input.email, fullName: input.fullName, role: input.roleCode },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return { userId: user.id };
}

// -----------------------------------------------------------------------------
// Peran
// -----------------------------------------------------------------------------

export async function listRoles(
  tx: TenantClient,
  tenantId: string,
): Promise<
  Array<{ id: string; code: string; name: string; isSystem: boolean; permissions: string[]; userCount: number }>
> {
  const rows = await tx.role.findMany({
    where: { tenantId },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true,
      permissions: { select: { permissionCode: true } },
      _count: { select: { users: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.isSystem,
    permissions: r.permissions.map((p) => p.permissionCode).sort(),
    userCount: r._count.users,
  }));
}

/**
 * Mengganti seluruh permission sebuah peran.
 *
 * Mengganti, bukan menambah/mengurangi satu per satu. Matriks peran × permission
 * adalah layar yang disimpan sekaligus, dan bentuk API-nya mengikuti bentuk
 * layarnya — dua permintaan terpisah untuk "tambah A" dan "hapus B" akan
 * meninggalkan keadaan setengah tersimpan bila yang kedua gagal.
 *
 * Setiap pengguna pemegang peran ini naik versi aksesnya, di transaksi yang sama.
 */
export async function setRolePermissions(
  tx: TenantClient,
  tenantId: string,
  roleId: string,
  permissionCodes: string[],
  ctx: ActorContext,
): Promise<{ permissions: string[]; affectedUsers: number }> {
  const role = await tx.role.findFirst({
    where: { id: roleId, tenantId },
    select: { id: true, code: true, permissions: { select: { permissionCode: true } } },
  });
  if (!role) throw new IamError('Peran tidak ditemukan', 'not_found');

  const requested = [...new Set(permissionCodes)];
  const known = await tx.permission.findMany({
    where: { code: { in: requested } },
    select: { code: true },
  });
  const unknown = requested.filter((c) => !known.some((k) => k.code === c));
  if (unknown.length > 0) {
    throw new IamError(`Permission tidak dikenal: ${unknown.join(', ')}`, 'not_found');
  }

  const before = role.permissions.map((p) => p.permissionCode).sort();

  // Only additions are capped (P6-13): removals must always be possible, and a
  // permission already on the role is not the actor's to answer for.
  await assertCanConfer(tx, tenantId, ctx.actorUserId, {
    permissions: requested.filter((code) => !before.includes(code)),
    roleCode: role.code,
  });

  await tx.rolePermission.deleteMany({ where: { roleId } });
  await tx.rolePermission.createMany({
    data: requested.map((permissionCode) => ({ tenantId, roleId, permissionCode })),
  });

  const holders = await tx.userRole.findMany({
    where: { roleId, tenantId },
    select: { userId: true },
  });
  for (const { userId } of holders) {
    await bumpAccessVersion(tx, tenantId, userId);
  }

  await writeAudit(tx, tenantId, {
    action: 'iam.role.permissions_changed',
    entityType: 'role',
    entityId: roleId,
    actorUserId: ctx.actorUserId,
    before: { permissions: before },
    after: { permissions: requested.sort() },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  await publishEvent(tx, tenantId, {
    topic: EventTopic.ACCESS_CHANGED,
    payload: { tenantId, roleId, affectedUsers: holders.length },
    correlationId: ctx.correlationId,
  });

  return { permissions: requested.sort(), affectedUsers: holders.length };
}

// -----------------------------------------------------------------------------
// Hak akses khusus per pengguna
// -----------------------------------------------------------------------------

/**
 * Memberi atau mencabut satu permission untuk satu pengguna, di luar perannya.
 *
 * `reason` wajib dan minimal 8 karakter — ditegakkan constraint basis data, bukan
 * hanya validasi aplikasi. Grant tanpa alasan tidak dapat ditinjau ulang enam
 * bulan kemudian, dan access review yang tidak dapat menjawab "mengapa" hanyalah
 * daftar yang di-scroll lalu disetujui.
 *
 * `expiresAt` sangat dianjurkan untuk akses sementara. Grant tanpa kedaluwarsa
 * adalah grant yang akan tertinggal.
 */
export async function setUserGrant(
  tx: TenantClient,
  tenantId: string,
  input: {
    userId: string;
    permissionCode: string;
    effect: 'GRANT' | 'DENY';
    reason: string;
    expiresAt?: Date | undefined;
  },
  ctx: ActorContext,
): Promise<{ accessVersion: number }> {
  const [user, permission] = await Promise.all([
    tx.user.findFirst({ where: { id: input.userId, tenantId }, select: { id: true } }),
    tx.permission.findUnique({ where: { code: input.permissionCode }, select: { code: true } }),
  ]);
  if (!user) throw new IamError('Pengguna tidak ditemukan', 'not_found');
  if (!permission) throw new IamError('Permission tidak dikenal', 'not_found');

  // A DENY confers nothing, so only a GRANT is capped — but the owner check
  // applies to both, since a DENY is exactly how a delegate would lock the
  // owner out (P6-13).
  await assertCanConfer(tx, tenantId, ctx.actorUserId, {
    permissions: input.effect === 'GRANT' ? [input.permissionCode] : [],
    targetUserId: input.userId,
  });

  await tx.userPermissionGrant.upsert({
    where: {
      userId_permissionCode: { userId: input.userId, permissionCode: input.permissionCode },
    },
    create: {
      tenantId,
      userId: input.userId,
      permissionCode: input.permissionCode,
      effect: input.effect,
      reason: input.reason,
      grantedBy: ctx.actorUserId,
      expiresAt: input.expiresAt ?? null,
    },
    update: {
      effect: input.effect,
      reason: input.reason,
      grantedBy: ctx.actorUserId,
      expiresAt: input.expiresAt ?? null,
    },
  });

  const accessVersion = await bumpAccessVersion(tx, tenantId, input.userId);

  await writeAudit(tx, tenantId, {
    action: input.effect === 'GRANT' ? 'iam.grant.added' : 'iam.deny.added',
    entityType: 'user',
    entityId: input.userId,
    actorUserId: ctx.actorUserId,
    after: {
      permissionCode: input.permissionCode,
      effect: input.effect,
      reason: input.reason,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return { accessVersion };
}

/** Menghapus hak akses khusus, mengembalikan pengguna ke izin perannya saja. */
export async function removeUserGrant(
  tx: TenantClient,
  tenantId: string,
  input: { userId: string; permissionCode: string },
  ctx: ActorContext,
): Promise<{ accessVersion: number }> {
  const existing = await tx.userPermissionGrant.findFirst({
    where: { tenantId, userId: input.userId, permissionCode: input.permissionCode },
    select: { effect: true },
  });
  if (!existing) throw new IamError('Hak akses khusus tidak ditemukan', 'not_found');

  // Lifting a DENY restores the permission, so it is capped like a GRANT (P6-13).
  await assertCanConfer(tx, tenantId, ctx.actorUserId, {
    permissions: existing.effect === 'DENY' ? [input.permissionCode] : [],
    targetUserId: input.userId,
  });

  const removed = await tx.userPermissionGrant.deleteMany({
    where: { tenantId, userId: input.userId, permissionCode: input.permissionCode },
  });
  if (removed.count === 0) throw new IamError('Hak akses khusus tidak ditemukan', 'not_found');

  const accessVersion = await bumpAccessVersion(tx, tenantId, input.userId);

  await writeAudit(tx, tenantId, {
    action: 'iam.grant.removed',
    entityType: 'user',
    entityId: input.userId,
    actorUserId: ctx.actorUserId,
    before: { permissionCode: input.permissionCode },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return { accessVersion };
}
