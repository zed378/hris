import { fileURLToPath } from 'node:url';
import { DEFAULT_LEAVE_TYPES, DEFAULT_PAYROLL_COMPONENTS } from '@hrms/contracts';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

/**
 * Seeds the product catalogue and one demo tenant.
 *
 * Runs as the **owner** role: the catalogue (modules, plans, permissions, menus)
 * is deliberately read-only to the application, because adding a module is a
 * product decision that goes through a migration, not a runtime action.
 *
 * Idempotent. Running it repeatedly duplicates nothing.
 */
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

// -----------------------------------------------------------------------------
// The module catalogue
//
// Only the four domain modules in the 18-month scope (PLAN/12 §1). The other
// modules from the reference catalogue are deliberately absent — adding a row to
// this table is a promise to a customer, and an unbuilt promise costs more than
// an unwritten row.
// -----------------------------------------------------------------------------
const MODULES = [
  { code: 'core', name: 'Inti', tier: 'CORE', isCore: true, sortOrder: 0,
    description: 'Beranda, profil, dan pengaturan dasar. Selalu aktif.' },
  { code: 'iam', name: 'Pengguna & Hak Akses', tier: 'CORE', isCore: true, sortOrder: 1,
    description: 'Pengguna, peran, permission, dan tinjauan akses. Selalu aktif.' },
  { code: 'employee', name: 'Data Karyawan', tier: 'BASIC', isCore: false, sortOrder: 10,
    description: 'Database karyawan, struktur organisasi, kontrak, dokumen.' },
  { code: 'attendance', name: 'Presensi', tier: 'BASIC', isCore: false, sortOrder: 20,
    description: 'Kehadiran harian, shift, geolokasi, bukti foto.' },
  { code: 'leave', name: 'Cuti', tier: 'BASIC', isCore: false, sortOrder: 30,
    description: 'Pengajuan cuti, saldo, kalender tim.' },
  { code: 'payroll', name: 'Penggajian', tier: 'BASIC', isCore: false, sortOrder: 40,
    description: 'Komponen gaji, PPh21, BPJS, slip gaji.' },
] as const;

const PLANS = [
  { code: 'trial', name: 'Uji Coba', sortOrder: 0,
    modules: ['employee', 'attendance', 'leave', 'payroll'],
    description: 'Seluruh modul selama 14 hari.' },
  { code: 'starter', name: 'Starter', sortOrder: 10,
    modules: ['employee', 'attendance', 'leave'],
    description: 'Karyawan, presensi, dan cuti. Tanpa penggajian.' },
  { code: 'basic', name: 'Basic', sortOrder: 20,
    modules: ['employee', 'attendance', 'leave', 'payroll'],
    description: 'Setara Paket Basic produk referensi.' },
] as const;

// -----------------------------------------------------------------------------
// Permissions
//
// Format: <module>.<resource>.<action>[.<scope>]
// The `own` scope means one's own data; `team` direct reports; `all` the whole
// tenant. Keeping the scope in the permission code — rather than as hidden logic
// inside a handler — is what makes "a line manager receives no cost widget"
// testable rather than merely believed.
// -----------------------------------------------------------------------------
const PERMISSIONS: Array<[string, string, string]> = [
  ['core', 'core.dashboard.view.own', 'Melihat beranda milik sendiri'],
  ['core', 'core.dashboard.view.team', 'Melihat dashboard tim'],
  ['core', 'core.dashboard.view.tenant', 'Melihat dashboard seluruh perusahaan'],
  ['core', 'core.profile.read.own', 'Melihat profil sendiri'],
  ['core', 'core.profile.update.own', 'Mengubah profil sendiri'],
  ['core', 'core.settings.manage', 'Mengelola pengaturan perusahaan'],

  ['iam', 'iam.user.read', 'Melihat daftar pengguna'],
  ['iam', 'iam.user.create', 'Menambah pengguna'],
  ['iam', 'iam.user.update', 'Mengubah pengguna'],
  ['iam', 'iam.role.read', 'Melihat peran'],
  ['iam', 'iam.role.manage', 'Mengelola peran dan permission-nya'],
  ['iam', 'iam.grant.manage', 'Memberi dan mencabut hak akses khusus'],
  ['iam', 'iam.audit.read', 'Membaca jejak audit'],

  ['employee', 'employee.employee.read.own', 'Melihat data karyawan sendiri'],
  ['employee', 'employee.employee.read.team', 'Melihat data karyawan satu tim'],
  ['employee', 'employee.employee.read.all', 'Melihat seluruh data karyawan'],
  ['employee', 'employee.employee.create', 'Menambah karyawan'],
  ['employee', 'employee.employee.update', 'Mengubah data karyawan'],
  ['employee', 'employee.pii.unmask', 'Membuka masking NIK, NPWP, dan rekening'],
  ['employee', 'employee.import.execute', 'Menjalankan impor Excel'],
  ['employee', 'employee.export.execute', 'Mengekspor data karyawan'],
  ['employee', 'employee.document.read', 'Melihat dokumen karyawan'],
  ['employee', 'employee.document.manage', 'Mengunggah dan mengarsipkan dokumen karyawan'],
  ['employee', 'employee.contract.read', 'Melihat kontrak kerja'],
  ['employee', 'employee.contract.manage', 'Mengelola kontrak kerja'],

  ['attendance', 'attendance.punch.create.own', 'Melakukan presensi sendiri'],
  ['attendance', 'attendance.record.read.own', 'Melihat presensi sendiri'],
  ['attendance', 'attendance.record.read.team', 'Melihat presensi tim'],
  ['attendance', 'attendance.record.read.all', 'Melihat seluruh presensi'],
  ['attendance', 'attendance.record.correct', 'Mengoreksi catatan presensi'],
  ['attendance', 'attendance.review.handle', 'Meninjau presensi yang ditandai'],
  ['attendance', 'attendance.shift.manage', 'Mengelola shift dan jadwal'],
  ['attendance', 'attendance.period.close', 'Menutup periode presensi'],

  ['leave', 'leave.request.create.own', 'Mengajukan cuti'],
  ['leave', 'leave.request.read.own', 'Melihat pengajuan cuti sendiri'],
  ['leave', 'leave.request.read.team', 'Melihat pengajuan cuti tim'],
  ['leave', 'leave.request.read.all', 'Melihat seluruh pengajuan cuti'],
  ['leave', 'leave.request.approve', 'Menyetujui pengajuan cuti'],
  ['leave', 'leave.balance.read.own', 'Melihat saldo cuti sendiri'],
  ['leave', 'leave.balance.manage', 'Mengelola saldo dan kebijakan cuti'],
  ['leave', 'leave.policy.manage', 'Mengelola jenis dan kebijakan cuti'],

  ['payroll', 'payroll.payslip.read.own', 'Melihat slip gaji sendiri'],
  ['payroll', 'payroll.payslip.read.all', 'Melihat seluruh slip gaji'],
  ['payroll', 'payroll.run.execute', 'Menjalankan proses penggajian'],
  ['payroll', 'payroll.run.approve', 'Menyetujui hasil penggajian'],
  ['payroll', 'payroll.component.manage', 'Mengelola komponen gaji'],
  ['payroll', 'payroll.salary.read', 'Melihat struktur gaji karyawan'],
  ['payroll', 'payroll.salary.manage', 'Mengelola struktur gaji karyawan'],
  ['payroll', 'payroll.statutory.manage', 'Mengelola konfigurasi pajak dan BPJS'],
];

interface MenuSeed {
  code: string;
  label: string;
  moduleCode: string;
  permissionCode?: string;
  path?: string;
  icon?: string;
  sortOrder: number;
  children?: MenuSeed[];
}

const MENUS: MenuSeed[] = [
  { code: 'home', label: 'Beranda', moduleCode: 'core', path: '/', icon: 'home', sortOrder: 0,
    permissionCode: 'core.dashboard.view.own' },
  { code: 'employees', label: 'Karyawan', moduleCode: 'employee', icon: 'users', sortOrder: 10,
    children: [
      { code: 'employees.list', label: 'Daftar Karyawan', moduleCode: 'employee',
        permissionCode: 'employee.employee.read.all', path: '/employees', sortOrder: 0 },
      { code: 'employees.grid', label: 'Grid Karyawan', moduleCode: 'employee',
        permissionCode: 'employee.employee.read.all', path: '/employees/grid', sortOrder: 5 },
      { code: 'employees.import', label: 'Impor Excel', moduleCode: 'employee',
        permissionCode: 'employee.import.execute', path: '/employees/import', sortOrder: 10 },
      { code: 'employees.documents', label: 'Dokumen Karyawan', moduleCode: 'employee',
        permissionCode: 'employee.document.read', path: '/employees/documents', sortOrder: 15 },
      { code: 'employees.contracts', label: 'Kontrak Kerja', moduleCode: 'employee',
        permissionCode: 'employee.contract.read', path: '/employees/contracts', sortOrder: 20 },
    ] },
  { code: 'attendance', label: 'Presensi', moduleCode: 'attendance', icon: 'clock', sortOrder: 20,
    children: [
      // The punch button is placed FIRST in its group, deliberately. It is the
      // only menu opened every day by everyone; the rest are opened by HR
      // occasionally.
      { code: 'attendance.punch', label: 'Absen Sekarang', moduleCode: 'attendance',
        permissionCode: 'attendance.punch.create.own', path: '/attendance/punch', sortOrder: 0 },
      { code: 'attendance.me', label: 'Presensi Saya', moduleCode: 'attendance',
        permissionCode: 'attendance.record.read.own', path: '/attendance/me', sortOrder: 5 },
      { code: 'attendance.consent', label: 'Persetujuan Data', moduleCode: 'attendance',
        permissionCode: 'attendance.punch.create.own', path: '/attendance/consent', sortOrder: 8 },
      { code: 'attendance.live', label: 'Dasbor Langsung', moduleCode: 'attendance',
        permissionCode: 'attendance.record.read.all', path: '/attendance/live', sortOrder: 9 },
      { code: 'attendance.records', label: 'Rekap Kehadiran', moduleCode: 'attendance',
        permissionCode: 'attendance.record.read.all', path: '/attendance/records', sortOrder: 10 },
      { code: 'attendance.device', label: 'Impor Mesin Absensi', moduleCode: 'attendance',
        permissionCode: 'attendance.record.correct', path: '/attendance/device-import', sortOrder: 15 },
      { code: 'attendance.review', label: 'Antrean Tinjauan', moduleCode: 'attendance',
        permissionCode: 'attendance.review.handle', path: '/attendance/review', sortOrder: 20 },
      { code: 'attendance.shifts', label: 'Shift & Jadwal', moduleCode: 'attendance',
        permissionCode: 'attendance.shift.manage', path: '/attendance/shifts', sortOrder: 30 },
    ] },
  { code: 'leave', label: 'Cuti', moduleCode: 'leave', icon: 'calendar', sortOrder: 30,
    children: [
      { code: 'leave.me', label: 'Cuti Saya', moduleCode: 'leave',
        permissionCode: 'leave.request.read.own', path: '/leave/me', sortOrder: 0 },
      { code: 'leave.approvals', label: 'Persetujuan', moduleCode: 'leave',
        permissionCode: 'leave.request.approve', path: '/leave/approvals', sortOrder: 10 },
      { code: 'leave.calendar', label: 'Kalender Cuti', moduleCode: 'leave',
        permissionCode: 'leave.request.read.team', path: '/leave/calendar', sortOrder: 15 },
      { code: 'leave.policies', label: 'Kebijakan Cuti', moduleCode: 'leave',
        permissionCode: 'leave.policy.manage', path: '/leave/policies', sortOrder: 20 },
    ] },
  { code: 'payroll', label: 'Penggajian', moduleCode: 'payroll', icon: 'wallet', sortOrder: 40,
    children: [
      { code: 'payroll.payslips.me', label: 'Slip Gaji Saya', moduleCode: 'payroll',
        permissionCode: 'payroll.payslip.read.own', path: '/payroll/me', sortOrder: 0 },
      { code: 'payroll.runs', label: 'Proses Gaji', moduleCode: 'payroll',
        permissionCode: 'payroll.run.execute', path: '/payroll/runs', sortOrder: 10 },
      { code: 'payroll.structures', label: 'Struktur Gaji', moduleCode: 'payroll',
        permissionCode: 'payroll.salary.read', path: '/payroll/structures', sortOrder: 15 },
      { code: 'payroll.components', label: 'Komponen Gaji', moduleCode: 'payroll',
        permissionCode: 'payroll.component.manage', path: '/payroll/components', sortOrder: 20 },
    ] },
  { code: 'settings', label: 'Pengaturan', moduleCode: 'iam', icon: 'settings', sortOrder: 90,
    children: [
      { code: 'settings.subscription', label: 'Langganan & Modul', moduleCode: 'core',
        permissionCode: 'core.settings.manage', path: '/settings/subscription', sortOrder: -10 },
      { code: 'settings.users', label: 'Pengguna', moduleCode: 'iam',
        permissionCode: 'iam.user.read', path: '/settings/users', sortOrder: 0 },
      { code: 'settings.roles', label: 'Peran & Hak Akses', moduleCode: 'iam',
        permissionCode: 'iam.role.read', path: '/settings/roles', sortOrder: 10 },
      { code: 'settings.audit', label: 'Jejak Audit', moduleCode: 'iam',
        permissionCode: 'iam.audit.read', path: '/settings/audit', sortOrder: 20 },
    ] },
];

// -----------------------------------------------------------------------------
// System roles
//
// Created for every new tenant. EMPLOYEE deliberately gets the fewest
// permissions that still let someone work — adding a permission to a base role
// is far easier than taking one back after hundreds of people have come to rely
// on it.
// -----------------------------------------------------------------------------
const SYSTEM_ROLES: Array<{ code: string; name: string; permissions: string[] | '*' }> = [
  { code: 'TENANT_OWNER', name: 'Pemilik Akun', permissions: '*' },
  {
    code: 'HR_ADMIN',
    name: 'Admin HR',
    permissions: [
      'core.dashboard.view.own', 'core.dashboard.view.tenant', 'core.profile.read.own',
      'core.profile.update.own', 'core.settings.manage',
      'iam.user.read', 'iam.user.create', 'iam.user.update', 'iam.role.read', 'iam.audit.read',
      'employee.employee.read.all', 'employee.employee.create', 'employee.employee.update',
      'employee.pii.unmask', 'employee.import.execute', 'employee.export.execute',
      'employee.document.read', 'employee.document.manage',
      'employee.contract.read', 'employee.contract.manage',
      'attendance.punch.create.own', 'attendance.record.read.own', 'attendance.record.read.all',
      'attendance.record.correct', 'attendance.review.handle', 'attendance.shift.manage',
      'attendance.period.close',
      'leave.request.create.own', 'leave.request.read.own', 'leave.request.read.all',
      'leave.request.approve', 'leave.balance.read.own', 'leave.balance.manage',
      'leave.policy.manage',
      'payroll.payslip.read.own', 'payroll.payslip.read.all', 'payroll.run.execute',
      'payroll.run.approve',
      'payroll.component.manage', 'payroll.salary.read', 'payroll.salary.manage',
    ],
  },
  {
    code: 'DEPT_HEAD',
    name: 'Kepala Departemen',
    permissions: [
      'core.dashboard.view.own', 'core.dashboard.view.team', 'core.profile.read.own',
      'core.profile.update.own',
      'employee.employee.read.own', 'employee.employee.read.team',
      'attendance.punch.create.own', 'attendance.record.read.own', 'attendance.record.read.team',
      'leave.request.create.own', 'leave.request.read.own', 'leave.request.read.team',
      'leave.request.approve', 'leave.balance.read.own',
      'payroll.payslip.read.own',
    ],
  },
  {
    code: 'LINE_MANAGER',
    name: 'Manajer Lini',
    permissions: [
      'core.dashboard.view.own', 'core.dashboard.view.team', 'core.profile.read.own',
      'core.profile.update.own',
      'employee.employee.read.own', 'employee.employee.read.team',
      'attendance.punch.create.own', 'attendance.record.read.own', 'attendance.record.read.team',
      'leave.request.create.own', 'leave.request.read.own', 'leave.request.read.team',
      'leave.request.approve', 'leave.balance.read.own',
      'payroll.payslip.read.own',
    ],
  },
  {
    code: 'EMPLOYEE',
    name: 'Karyawan',
    permissions: [
      'core.dashboard.view.own', 'core.profile.read.own', 'core.profile.update.own',
      'employee.employee.read.own',
      'attendance.punch.create.own', 'attendance.record.read.own',
      'leave.request.create.own', 'leave.request.read.own', 'leave.balance.read.own',
      'payroll.payslip.read.own',
    ],
  },
];

async function seedCatalog(): Promise<void> {
  for (const m of MODULES) {
    await db.module.upsert({
      where: { code: m.code },
      create: { ...m },
      update: { name: m.name, description: m.description, tier: m.tier, isCore: m.isCore, sortOrder: m.sortOrder },
    });
  }

  for (const p of PLANS) {
    await db.plan.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, description: p.description, sortOrder: p.sortOrder },
      update: { name: p.name, description: p.description, sortOrder: p.sortOrder },
    });
    for (const moduleCode of p.modules) {
      await db.planModule.upsert({
        where: { planCode_moduleCode: { planCode: p.code, moduleCode } },
        create: { planCode: p.code, moduleCode },
        update: {},
      });
    }
  }

  for (const [moduleCode, code, description] of PERMISSIONS) {
    await db.permission.upsert({
      where: { code },
      create: { code, moduleCode, description },
      update: { moduleCode, description },
    });
  }

  async function seedMenu(items: MenuSeed[], parentId: string | null): Promise<void> {
    for (const item of items) {
      const row = await db.menu.upsert({
        where: { code: item.code },
        create: {
          code: item.code, label: item.label, moduleCode: item.moduleCode,
          permissionCode: item.permissionCode ?? null, path: item.path ?? null,
          icon: item.icon ?? null, sortOrder: item.sortOrder, parentId,
        },
        update: {
          label: item.label, moduleCode: item.moduleCode,
          permissionCode: item.permissionCode ?? null, path: item.path ?? null,
          icon: item.icon ?? null, sortOrder: item.sortOrder, parentId,
        },
        select: { id: true },
      });
      if (item.children) await seedMenu(item.children, row.id);
    }
  }
  await seedMenu(MENUS, null);
}

/**
 * The demo tenant.
 *
 * Deliberately on the `starter` plan — without payroll. That makes entitlement
 * enforcement visible from day one: the Payroll menu is not rendered, and its
 * endpoints refuse with 402 even though TENANT_OWNER holds every permission. If
 * either fails to happen, something is wrong and it is better known now.
 */
async function seedDemoTenant(): Promise<string> {
  const { hashPassword } = await import('@node-rs/argon2').then((m) => ({
    hashPassword: (p: string) => m.hash(p, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
  }));

  const tenant = await db.tenant.upsert({
    where: { code: 'demo' },
    create: {
      code: 'demo', name: 'PT Demo Nusantara', planCode: 'basic', status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
    },
    update: {},
    select: { id: true },
  });

  const plan = await db.plan.findUniqueOrThrow({
    where: { code: 'basic' },
    select: { modules: { select: { moduleCode: true } } },
  });
  for (const { moduleCode } of plan.modules) {
    await db.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId: tenant.id, moduleCode } },
      create: { tenantId: tenant.id, moduleCode, status: 'ENABLED', enabledAt: new Date() },
      update: {},
    });
  }

  const allPermissions = await db.permission.findMany({ select: { code: true } });
  for (const role of SYSTEM_ROLES) {
    const row = await db.role.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: role.code } },
      create: { tenantId: tenant.id, code: role.code, name: role.name, isSystem: true },
      update: { name: role.name },
      select: { id: true },
    });
    const codes = role.permissions === '*' ? allPermissions.map((p) => p.code) : role.permissions;
    for (const permissionCode of codes) {
      await db.rolePermission.upsert({
        where: { roleId_permissionCode: { roleId: row.id, permissionCode } },
        create: { tenantId: tenant.id, roleId: row.id, permissionCode },
        update: {},
      });
    }
  }

  const passwordHash = await hashPassword('DemoPassword123');
  const people = [
    { email: 'owner@demo.test', fullName: 'Rina Owner', role: 'TENANT_OWNER' },
    { email: 'hr@demo.test', fullName: 'Budi HR', role: 'HR_ADMIN' },
    { email: 'manager@demo.test', fullName: 'Sari Manajer', role: 'LINE_MANAGER' },
    { email: 'staff@demo.test', fullName: 'Andi Staf', role: 'EMPLOYEE' },
  ];

  for (const person of people) {
    const user = await db.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: person.email } },
      create: {
        tenantId: tenant.id, email: person.email, fullName: person.fullName,
        passwordHash, status: 'ACTIVE',
      },
      update: {},
      select: { id: true },
    });
    const role = await db.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: tenant.id, code: person.role } },
      select: { id: true },
    });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { tenantId: tenant.id, userId: user.id, roleId: role.id },
      update: {},
    });
    await db.accessVersion.upsert({
      where: { userId: user.id },
      create: { tenantId: tenant.id, userId: user.id, version: 1 },
      update: {},
    });
  }

  return tenant.id;
}

/**
 * The demo superuser.
 *
 * Its TOTP secret is fixed (not random) so a developer can generate a valid code
 * from a script without scanning a QR. For local environments only — in
 * production a superuser is created through a separate procedure, and a database
 * constraint refuses an active account with no TOTP secret.
 */
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * The initial attendance data for the demo tenant.
 *
 * The work site uses the coordinates of the Monas monument — a point that is
 * easy to recognise when testing the geofence from any map. A 150 m radius is a
 * reasonable value for one office building; a factory site is usually far larger.
 */
async function seedAttendance(tenantId: string): Promise<void> {
  await db.workSite.upsert({
    where: { tenantId_code: { tenantId, code: 'pusat' } },
    create: {
      tenantId,
      code: 'pusat',
      name: 'Kantor Pusat',
      latitude: -6.1753924,
      longitude: 106.8271528,
      radiusM: 150,
      maxAccuracyM: 100,
    },
    update: {},
  });

  const shifts = [
    // A 15-minute tolerance on the morning shift: Jakarta traffic makes a
    // 5-minute tolerance record the entire office as late every day, and a figure
    // that is always red stops being read by anyone.
    { code: 'pagi', name: 'Shift Pagi', startMinute: 8 * 60, endMinute: 17 * 60, graceMinutes: 15, breakMinutes: 60 },
    { code: 'siang', name: 'Shift Siang', startMinute: 14 * 60, endMinute: 22 * 60, graceMinutes: 10, breakMinutes: 45 },
    // The night shift is expressed as passing 1440 — 22:00 until 06:00 the next
    // day. That is what keeps one working date from being split in two.
    { code: 'malam', name: 'Shift Malam', startMinute: 22 * 60, endMinute: 30 * 60, graceMinutes: 10, breakMinutes: 45 },
  ];

  for (const shift of shifts) {
    await db.shift.upsert({
      where: { tenantId_code: { tenantId, code: shift.code } },
      create: { tenantId, ...shift },
      update: { name: shift.name },
    });
  }

  // The 2026 national holidays with fixed dates. The ones following the Hijri
  // calendar are deliberately not seeded: their dates are set by a joint
  // ministerial decree, and guessing is worse than leaving them empty.
  const holidays = [
    { date: '2026-01-01', name: 'Tahun Baru Masehi' },
    { date: '2026-05-01', name: 'Hari Buruh Internasional' },
    { date: '2026-06-01', name: 'Hari Lahir Pancasila' },
    { date: '2026-08-17', name: 'Hari Kemerdekaan RI' },
    { date: '2026-12-25', name: 'Hari Raya Natal' },
  ];

  for (const holiday of holidays) {
    await db.holiday.upsert({
      where: { tenantId_date: { tenantId, date: new Date(holiday.date) } },
      create: { tenantId, date: new Date(holiday.date), name: holiday.name },
      update: { name: holiday.name },
    });
  }
}

/**
 * The default leave types under Indonesian labour law.
 *
 * The figures are not guesses: 12 days of annual leave after 12 months of
 * service (Law 13/2003 Article 79), 3 months of maternity leave (Article 82),
 * 2 days for marriage and for the death of an immediate family member
 * (Article 93).
 *
 * Maternity and sick leave do not deduct from the balance — both are rights not
 * based on an annual quota, and deducting them from the 12-day allowance would
 * cost a mother her entire annual leave for giving birth.
 */
async function seedLeaveTypes(tenantId: string): Promise<void> {
  // Taken from `@hrms/contracts` rather than rewritten here.
  //
  // This list once existed only in the seed, so a real tenant registering itself
  // was born with NO leave types at all — its module active, its menu shown, and
  // its dropdown empty. `provisionTenant` now uses the same list, and copying it
  // here would make the two diverge at the first change somebody forgets to copy.
  const types = DEFAULT_LEAVE_TYPES;

  for (const type of types) {
    await db.leaveType.upsert({
      where: { tenantId_code: { tenantId, code: type.code } },
      create: { tenantId, ...type },
      update: { name: type.name },
    });
  }
}

/**
 * Example salary components.
 *
 * DELIBERATELY containing neither PPh21 nor BPJS. Both are locked behind Gate C
 * (document 12 §P5): a payroll expert engaged, 30 real payslips as test cases,
 * and spike S1 passing 30/30. Putting a tax figure in the seed means putting a
 * figure nobody has checked into every new tenant's database — and that figure
 * will look official precisely because it has been there from the start.
 *
 * What is here is only the components whose shape is universal and that need no
 * interpretation of regulation: basic salary, a fixed allowance, a daily
 * attendance allowance, hourly overtime, and the absence deduction.
 */
async function seedPayrollComponents(tenantId: string): Promise<void> {
  const components = DEFAULT_PAYROLL_COMPONENTS;

  for (const component of components) {
    await db.payrollComponent.upsert({
      where: { tenantId_code: { tenantId, code: component.code } },
      create: { tenantId, ...component },
      update: { name: component.name },
    });
  }
}

async function seedSuperuser(): Promise<void> {
  const { hash } = await import('@node-rs/argon2');
  await db.superuser.upsert({
    where: { email: 'admin@hrms.test' },
    create: {
      email: 'admin@hrms.test',
      fullName: 'Platform Admin',
      passwordHash: await hash('AdminPassword123', {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
      totpSecret: DEMO_TOTP_SECRET,
      isActive: true,
    },
    update: { totpSecret: DEMO_TOTP_SECRET, isActive: true },
  });
}

async function main(): Promise<void> {
  await seedCatalog();
  const tenantId = await seedDemoTenant();
  await seedAttendance(tenantId);
  await seedLeaveTypes(tenantId);
  await seedPayrollComponents(tenantId);
  await seedSuperuser();

  const counts = {
    modul: await db.module.count(),
    paket: await db.plan.count(),
    permission: await db.permission.count(),
    menu: await db.menu.count(),
    tenant: await db.tenant.count(),
    pengguna: await db.user.count(),
    lokasiKerja: await db.workSite.count(),
    shift: await db.shift.count(),
    hariLibur: await db.holiday.count(),
    jenisCuti: await db.leaveType.count(),
    komponenGaji: await db.payrollComponent.count(),
  };
  console.log('Seed selesai:', counts);
  console.log('Login demo — tenantCode: demo | owner@demo.test | DemoPassword123');
  console.log('Paket basic: employee, attendance, leave, payroll aktif.');
  console.log(`Admin demo — admin@hrms.test | AdminPassword123 | TOTP secret: ${DEMO_TOTP_SECRET}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
