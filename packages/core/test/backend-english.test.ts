import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The backend speaks English (ADR-030, P6-24).
 *
 * API messages, validation messages, logs, and errors are English; the
 * frontend maps `code` and `reason` to Indonesian and never shows a server
 * `message`. A translation pass that misses one file leaves an Indonesian
 * sentence for the next reader to copy, so this reads every backend string
 * literal and template with the TypeScript parser — comments are not strings
 * and are not checked — and names any that contain common Indonesian words.
 *
 * Exempt, by decision:
 *   - seeded display data people read (ADR-030): menu labels, role names,
 *     leave types, holidays, default payroll components;
 *   - emails and push notifications (ADR-034).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED = [
  'packages/core/src',
  'packages/contracts/src',
  'packages/db/src',
  'packages/cache/src',
  'packages/observability/src',
  'apps/auth/src',
  'apps/worker/src',
  'apps/web/src/app/api',
  'apps/web/src/app/admin/api',
  'apps/web/src/lib',
];

/**
 * Whole files whose Indonesian is the product, not a leftover. Anything finer
 * is marked where it stands: `// lang: id — <reason>` on the literal's line or
 * the line above, or a `// lang: id-begin` … `// lang: id-end` block.
 */
const EXEMPT: Record<string, string> = {
  'packages/core/src/notification/templates.ts': 'emails people read (ADR-034)',
  'apps/worker/src/leave-notify.ts': 'push text people read (ADR-034)',
  'packages/contracts/src/tenant-defaults.ts': 'seeded leave types and salary components (ADR-030)',
};

/** Line numbers (0-based) exempted by a `lang: id` marker. */
function markedLines(text: string): Set<number> {
  const lines = text.split('\n');
  const marked = new Set<number>();
  let inBlock = false;
  lines.forEach((line, i) => {
    if (line.includes('lang: id-begin')) inBlock = true;
    const single = /lang: id(?!-)/.test(line);
    if (inBlock || single) marked.add(i);
    // A marker on a comment line of its own covers the line after it.
    if (single && line.trim().startsWith('//')) marked.add(i + 1);
    if (line.includes('lang: id-end')) inBlock = false;
  });
  return marked;
}

/**
 * Frontend helpers in `apps/web/src/lib` are client code whose words users DO
 * read, so they are Indonesian by design (ADR-030). Only the server-side files
 * there are backend.
 */
const WEB_LIB_SERVER = new Set([
  'define-route.ts',
  'define-admin-route.ts',
  'iam-error.ts',
  'leave-error.ts',
  'route-manifest.ts',
  'openapi.ts',
  'auth-client.ts',
  'session-cookie.ts',
]);

/**
 * Words that occur in Indonesian sentences and essentially never in English
 * ones. Short function words ("di", "ke") are left out: they collide with
 * identifiers and abbreviations.
 */
const INDONESIAN = [
  'tidak', 'yang', 'dengan', 'untuk', 'sudah', 'belum', 'harus', 'wajib', 'ditemukan',
  'karyawan', 'pengguna', 'peran', 'gagal', 'berhasil', 'sah', 'kunci', 'lebih', 'dari',
  'atau', 'boleh', 'masih', 'tanggal', 'berkas', 'kata sandi', 'cuti', 'presensi', 'saldo',
  'pengajuan', 'izin', 'hanya', 'dapat', 'silakan', 'terjadi', 'kesalahan', 'kosong',
  'diisi', 'dipasang', 'terdaftar', 'lampiran', 'gaji', 'periode', 'jadwal', 'lokasi',
  'anda', 'sertakan', 'sebutkan', 'minimal', 'modul', 'paket', 'langganan', 'sesi', 'tautan',
  'undangan', 'foto', 'ketukan', 'kantor', 'nilai', 'kolom', 'baris', 'jenis', 'bulan', 'tahun',
  'perusahaan', 'melebihi', 'ditolak', 'sistem', 'pemilik', 'penyetuju', 'keputusan', 'alasan',
  'ini', 'itu', 'akan', 'pada', 'oleh', 'telah', 'sedang', 'tanpa', 'setelah', 'sebelum', 'mohon',
  'coba', 'lagi', 'baru', 'semua', 'setiap', 'sebagai', 'tetapi', 'namun', 'karena', 'jika', 'bila',
  'agar', 'sekarang', 'hari', 'menit', 'detik', 'nama', 'nomor', 'alamat', 'surel', 'kode', 'terlalu',
  'membutuhkan', 'bukan', 'batas', 'batasnya', 'argumen', 'diberikan', 'sekurangnya', 'dalam',
  'tersedia', 'ada', 'tidak', 'belum', 'muat', 'ulang', 'halaman', 'buka', 'ganti', 'ubah', 'hapus',
];
const PATTERN = new RegExp(`\\b(${INDONESIAN.join('|')})\\b`, 'i');

function sources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function backendFiles(): string[] {
  return SCANNED.flatMap((dir) => sources(join(ROOT, dir)))
    .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
    .filter((file) => !EXEMPT[file])
    .filter((file) => !file.startsWith('apps/web/src/lib/') || WEB_LIB_SERVER.has(file.split('/').pop()!));
}

function indonesianLiterals(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const marked = markedLines(text);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      if (PATTERN.test(node.text) && !marked.has(line)) {
        found.push(`${file}:${line + 1}: ${node.text.slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('backend language (ADR-030)', () => {
  it('scans a meaningful number of files', () => {
    expect(backendFiles().length).toBeGreaterThan(100);
  });

  it('finds the guard working: an Indonesian sentence is detected', () => {
    expect(PATTERN.test('Data tidak sah')).toBe(true);
    expect(PATTERN.test('Invalid data')).toBe(false);
  });

  it('has no Indonesian in backend string literals', () => {
    const found = backendFiles().flatMap(indonesianLiterals);
    expect(found, `${found.length} Indonesian literals:\n${found.join('\n')}`).toEqual([]);
  });
});
