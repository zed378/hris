#!/usr/bin/env node
/**
 * Runner for migrations that must NOT run inside a transaction.
 *
 *   node ops/scripts/run-online-migrations.mjs            # apply
 *   node ops/scripts/run-online-migrations.mjs --dry-run  # list what would run
 *
 * ## Why this exists
 *
 * Prisma wraps every migration in a transaction and offers no way out. Verified
 * on 7.9.1: `CREATE INDEX CONCURRENTLY` fails with SQLSTATE 25001, and the
 * `-- prisma-no-transaction` marker our own linter used to suggest is borrowed
 * from other tools and does nothing here.
 *
 * That has been harmless so far only because every index built to date was on a
 * table created in the same migration — zero rows, instantaneous, nothing queued
 * behind the lock. It stops being harmless the first time an index or a
 * constraint is needed on `punch_logs` or `attendance_days`, which is risk R33:
 * a non-concurrent index build holds a write lock for the whole build, and on
 * the attendance tables that means every employee in the company fails to clock
 * in until it finishes.
 *
 * So: ordinary migrations stay with Prisma, and the handful that genuinely need
 * to be online live in `packages/db/prisma/migrations-online/` and run here.
 *
 * ## Ordering
 *
 * Run AFTER `prisma migrate deploy`, in the same deploy step. An online
 * migration adds an index or validates a constraint on a table the transactional
 * migrations have already created; the reverse order would fail on a table that
 * does not exist yet.
 *
 * ## What it does NOT do
 *
 * It does not roll back. Nothing here can: each statement commits on its own,
 * which is the entire point. A file that fails halfway leaves the statements
 * before it applied, and the runner says exactly which one stopped it so the
 * file can be made re-runnable and tried again.
 *
 * Every statement should therefore be written to be safe to repeat —
 * `IF NOT EXISTS`, `IF EXISTS`, `VALIDATE CONSTRAINT` on an already-valid
 * constraint. That is a real constraint on the author, and it is the price of
 * not holding a lock.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * `.env` is loaded when dotenv happens to be present, and skipped when it is not.
 *
 * Running this by hand on a developer machine should behave like running it from
 * a package script, which means reading `.env`. Running it inside the migrate
 * container should not require a package that container has no other reason to
 * carry — the environment is already set there, by compose.
 *
 * A hard import would make the second case fail at startup with a missing-module
 * error that says nothing about migrations.
 */
try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });
} catch {
  // Not installed. The environment is expected to be set already.
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'packages/db/prisma/migrations-online');

/**
 * An advisory lock, so two deploys cannot run this at once.
 *
 * Concurrent index builds on the same table do not merely duplicate work: the
 * second one fails, and a failed `CREATE INDEX CONCURRENTLY` leaves an INVALID
 * index behind that still costs write time and is never used for reads. The
 * number is arbitrary and only has to be stable.
 */
const LOCK_KEY = 8_150_2026;

/**
 * Splits SQL into statements, respecting the things a naive `;` split ruins.
 *
 * Dollar-quoted bodies are the reason this is not one line. `CREATE FUNCTION …
 * AS $$ … ; … $$` contains semicolons that do not end anything, and splitting on
 * them produces fragments that fail with errors pointing nowhere near the real
 * problem. Single-quoted literals, line comments, and block comments all hide
 * semicolons too.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Single-quoted literal, with '' as the escape
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar quote: $$ or $tag$
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (sql[i] === ';') {
      statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  if (current.trim() !== '') statements.push(current.trim());
  // Empty fragments only. Comment-only statements are dropped later by
  // `isBlank`, which strips comments properly rather than guessing from a prefix.
  return statements.filter((s) => s !== '');
}

/** True when a statement is nothing but comments. */
function isBlank(statement) {
  return statement
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim() === '';
}

async function main() {
  if (!existsSync(DIR)) {
    console.log('run-online-migrations: tidak ada migrasi online.');
    return 0;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL belum dipasang.');
    return 1;
  }

  const dryRun = process.argv.includes('--dry-run');
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._online_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        statements  integer NOT NULL
      )
    `);

    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock($1) AS held', [LOCK_KEY]);
    if (!lock[0].held) {
      console.error(
        'Deploy lain sedang menjalankan migrasi online. Dihentikan — dua CREATE INDEX ' +
          'CONCURRENTLY pada tabel yang sama tidak hanya mengulang pekerjaan, yang kedua ' +
          'gagal dan meninggalkan indeks INVALID.',
      );
      return 1;
    }

    const { rows: applied } = await client.query('SELECT name FROM public._online_migrations');
    const done = new Set(applied.map((r) => r.name));

    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;

    for (const file of files) {
      if (done.has(file)) continue;

      const statements = splitStatements(readFileSync(join(DIR, file), 'utf8')).filter(
        (s) => !isBlank(s),
      );

      if (dryRun) {
        console.log(`akan dijalankan: ${file} (${statements.length} pernyataan)`);
        ran += 1;
        continue;
      }

      console.log(`menjalankan ${file} (${statements.length} pernyataan)…`);

      for (const [index, statement] of statements.entries()) {
        try {
          // No BEGIN anywhere. Each statement commits on its own, which is the
          // whole reason this runner exists.
          await client.query(statement);
        } catch (error) {
          console.error(
            `\n${file}: pernyataan ${index + 1} gagal.\n` +
              `${statement.slice(0, 300)}\n\n${error.message}\n\n` +
              'Pernyataan sebelumnya SUDAH ter-commit dan tidak dibatalkan — itu ' +
              'konsekuensi berjalan di luar transaksi. Perbaiki berkasnya agar dapat ' +
              'dijalankan ulang dengan aman, lalu jalankan lagi.',
          );
          return 1;
        }
      }

      await client.query(
        'INSERT INTO public._online_migrations (name, statements) VALUES ($1, $2)',
        [file, statements.length],
      );
      ran += 1;
    }

    /**
     * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind.
     *
     * It is never used to answer a query and is still maintained on every write
     * — the worst of both — and nothing reports it. Checked on every run, so a
     * failure from a PREVIOUS deploy cannot sit unnoticed indefinitely.
     */
    const { rows: invalid } = await client.query(`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname NOT IN ('pg_catalog', 'pg_toast')
    `);

    if (invalid.length > 0) {
      console.error(
        `\nPERINGATAN: ${invalid.length} indeks INVALID ditemukan:\n` +
          invalid.map((r) => `  ${r.name}`).join('\n') +
          '\n\nIndeks INVALID tidak dipakai membaca tetapi tetap dipelihara pada setiap ' +
          'tulis. Ia sisa CREATE INDEX CONCURRENTLY yang gagal. Hapus dengan ' +
          'DROP INDEX CONCURRENTLY lalu bangun ulang.',
      );
      return 1;
    }

    console.log(
      ran === 0
        ? 'run-online-migrations: tidak ada yang baru.'
        : `run-online-migrations: ${ran} berkas ${dryRun ? 'akan dijalankan' : 'dijalankan'}.`,
    );
    return 0;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

/**
 * Only when run as a program.
 *
 * The splitter is imported by `packages/db/test/online-migrations.test.ts` —
 * imported rather than reimplemented, because a copy would pass while the real
 * one was broken. Without this guard, importing it would connect to a database
 * and apply migrations as a side effect of a unit test.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
