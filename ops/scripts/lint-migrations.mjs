#!/usr/bin/env node
/**
 * Linter migrasi — penegakan PLAN/09.
 *
 * Kebijakan migrasi non-destruktif hanya bertahan bila ditegakkan mesin. Sebagai
 * kesepakatan tim ia bertahan sampai deploy pertama yang terburu-buru pada Jumat
 * sore; sebagai gerbang CI ia bertahan seumur produk.
 *
 * Yang diperiksa bukan gaya penulisan, melainkan operasi yang tidak dapat
 * dibatalkan atau yang mengunci tabel di jam sibuk.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = join(ROOT, 'packages/db/prisma/migrations');

/**
 * Operasi terlarang.
 *
 * `DROP COLUMN` dan `RENAME` tidak dapat dibatalkan dan langsung merusak versi
 * aplikasi sebelumnya, sehingga rollback aplikasi berhenti menjadi aman (P12).
 * Penghapusan kolom hanya lewat tangga deprekasi berjenjang (PLAN/09 §5).
 */
const FORBIDDEN = [
  { pattern: /\bDROP\s+TABLE\b/i, rule: 'DROP TABLE',
    hint: 'Pakai tangga deprekasi (PLAN/09 §5), bukan penghapusan langsung.' },
  { pattern: /\bDROP\s+COLUMN\b/i, rule: 'DROP COLUMN',
    hint: 'Tandai kolom deprecated dan hentikan pembacaannya dulu (PLAN/09 §5).' },
  { pattern: /\bDROP\s+SCHEMA\b/i, rule: 'DROP SCHEMA', hint: 'Tidak pernah di produksi.' },
  { pattern: /\bTRUNCATE\b/i, rule: 'TRUNCATE', hint: 'Tidak dapat di-rollback per baris.' },
  { pattern: /\bALTER\s+TABLE\s+[^\s;]+\s+RENAME\b/i, rule: 'RENAME TABLE/COLUMN',
    hint: 'Tambah kolom baru, backfill, alihkan pembacaan, baru deprekasi yang lama.' },
  { pattern: /\bDROP\s+(NOT\s+NULL|DEFAULT)\b.*--\s*unsafe/i, rule: 'DROP constraint tanpa alasan',
    hint: 'Beri komentar alasan bila memang disengaja.' },
];

/**
 * Operasi yang mengunci tabel lebih lama dari yang dikira penulisnya.
 *
 * `CREATE INDEX` tanpa `CONCURRENTLY` memegang kunci tulis selama pembangunan
 * indeks — pada tabel presensi berukuran jutaan baris itu berarti seluruh
 * karyawan gagal absen selama migrasi berjalan (risiko R33).
 */
const REQUIRE_CONCURRENT = [
  { pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i, rule: 'CREATE INDEX non-concurrent',
    hint: 'Pakai CREATE INDEX CONCURRENTLY IF NOT EXISTS.' },
  { pattern: /\bDROP\s+INDEX\s+(?!CONCURRENTLY)/i, rule: 'DROP INDEX non-concurrent',
    hint: 'Pakai DROP INDEX CONCURRENTLY.' },
];

/**
 * Indeks pada tabel yang dibuat di migrasi yang sama tidak perlu CONCURRENTLY.
 *
 * Alasannya bukan kelonggaran: tabel itu baru saja lahir, isinya nol baris, dan
 * belum ada satu pun kode yang dapat memegangnya. Kunci yang diambil berlangsung
 * mikrodetik dan tidak ada yang mengantre di belakangnya — bahaya yang hendak
 * dicegah aturan ini sama sekali tidak hadir.
 *
 * Ini lebih baik daripada daftar migrasi yang dikecualikan. Daftar semacam itu
 * bertambah satu baris setiap kali seseorang terburu-buru, dan pada akhirnya
 * gerbangnya menjaga masa lalu, bukan masa depan.
 */
function tablesCreatedIn(sql) {
  const names = new Set();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    names.add(match[1].replace(/"/g, '').toLowerCase());
  }
  return names;
}

/** `CREATE INDEX "x" ON "schema"."table"(...)` → `schema.table` */
function indexTargetsIn(sql) {
  const targets = [];
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(?:IF\s+NOT\s+EXISTS\s+)?[^\s]+\s+ON\s+([^\s(]+)/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    targets.push(match[1].replace(/"/g, '').toLowerCase());
  }
  return targets;
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log('lint-migrations: belum ada migrasi.');
    return 0;
  }

  const violations = [];
  let checked = 0;

  for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(MIGRATIONS_DIR, entry.name, 'migration.sql');
    if (!existsSync(file)) continue;

    checked += 1;
    const raw = readFileSync(file, 'utf8');
    const sql = stripComments(raw);
    const where = relative(ROOT, file).replace(/\\/g, '/');

    for (const { pattern, rule, hint } of FORBIDDEN) {
      if (pattern.test(sql)) violations.push({ where, rule, hint });
    }

    const freshTables = tablesCreatedIn(sql);
    for (const target of indexTargetsIn(sql)) {
      if (!freshTables.has(target)) {
        violations.push({
          where,
          rule: `CREATE INDEX non-concurrent pada ${target}`,
          hint: 'Tabel ini sudah berisi data. Pakai CREATE INDEX CONCURRENTLY IF NOT EXISTS.',
        });
      }
    }

    for (const { pattern, rule, hint } of REQUIRE_CONCURRENT) {
      // Aturan DROP INDEX tetap berlaku tanpa pengecualian: menghapus indeks
      // selalu menyentuh tabel yang sudah hidup.
      if (rule.startsWith('DROP') && pattern.test(sql)) violations.push({ where, rule, hint });
    }

    // CONCURRENTLY tidak dapat berjalan di dalam blok transaksi. Prisma
    // membungkus setiap migrasi dalam transaksi kecuali diberi penanda ini.
    if (/\bCONCURRENTLY\b/i.test(sql) && !/--\s*prisma-no-transaction/i.test(raw)) {
      violations.push({
        where,
        rule: 'CONCURRENTLY di dalam transaksi',
        hint: 'Tambahkan baris pertama: -- prisma-no-transaction',
      });
    }
  }

  if (violations.length > 0) {
    console.error(`\nlint-migrations: ${violations.length} pelanggaran\n`);
    for (const v of violations) {
      console.error(`  ${v.where}`);
      console.error(`    ✗ ${v.rule}`);
      console.error(`      ${v.hint}\n`);
    }
    console.error('Aturan lengkap: PLAN/09-Non-Destructive-Migration-Strategy.md\n');
    return 1;
  }

  console.log(`lint-migrations: ${checked} migrasi diperiksa, bersih.`);
  return 0;
}

process.exit(main());
