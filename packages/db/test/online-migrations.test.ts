import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIR = join(ROOT, 'packages/db/prisma/migrations-online');

/**
 * The online migrations, and the runner that applies them.
 *
 * These exist because Prisma wraps every migration in a transaction and offers
 * no way out — verified on 7.9.1, where `CREATE INDEX CONCURRENTLY` fails with
 * SQLSTATE 25001. That was harmless only while every index was built on a table
 * created in the same migration. It stops being harmless the first time one is
 * needed on `punch_logs`, where a lock held for the length of a build is every
 * employee in the company unable to clock in (risk R33).
 *
 * Two properties are worth a test rather than a habit.
 */

/**
 * The splitter, imported from the runner itself rather than reimplemented.
 *
 * A copy here would pass while the real one was broken, which is the failure
 * mode this whole file exists to prevent.
 */
const { splitStatements } = (await import(
  join(ROOT, 'ops/scripts/run-online-migrations.mjs').replace(/\\/g, '/')
)) as { splitStatements: (sql: string) => string[] };

describe('splitting SQL into statements', () => {
  it('splits ordinary statements on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not require a trailing semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  /**
   * The reason this is not a one-line `split(';')`.
   *
   * A function body is full of semicolons that end nothing. Splitting on them
   * produces fragments that fail with errors pointing nowhere near the real
   * problem — and the migration is left half-applied, because nothing here runs
   * in a transaction.
   */
  it('keeps a dollar-quoted body whole', () => {
    const sql = `
      CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1;
        RETURN 2;
      END
      $$;
      SELECT 1;
    `;

    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('PERFORM 1;');
    expect(statements[0]).toContain('RETURN 2;');
    expect(statements[1]).toBe('SELECT 1');
  });

  it('keeps a tagged dollar quote whole', () => {
    const sql = `CREATE FUNCTION g() RETURNS text AS $body$ SELECT 'a;b' $body$; SELECT 2;`;
    const statements = splitStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('$body$');
  });

  it('ignores a semicolon inside a string literal', () => {
    const statements = splitStatements(`SELECT 'a;b'; SELECT 2;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(`SELECT 'a;b'`);
  });

  it('ignores a semicolon inside an escaped string literal', () => {
    const statements = splitStatements(`SELECT 'it''s; fine'; SELECT 2;`);
    expect(statements).toHaveLength(2);
  });

  it('ignores a semicolon inside a line comment', () => {
    const statements = splitStatements('-- a; b\nSELECT 1;');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('SELECT 1');
  });

  it('ignores a semicolon inside a block comment', () => {
    const statements = splitStatements('/* a; b */ SELECT 1;');
    expect(statements).toHaveLength(1);
  });

  it('returns nothing for an empty file', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   \n  ')).toEqual([]);
  });
});

describe('the online migration files', () => {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.sql')) : [];

  it('are all numbered, so their order is not the filesystem’s opinion', () => {
    for (const file of files) expect(file, file).toMatch(/^\d{4}_/);
  });

  /**
   * Every statement must be safe to run twice.
   *
   * Nothing here runs in a transaction — that is the entire point — so a file
   * that fails partway leaves everything before it committed, and the only sane
   * recovery is to run the file again. A statement that cannot tolerate that
   * turns one failed deploy into a manual repair.
   */
  it('are re-runnable', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const sql = readFileSync(join(DIR, file), 'utf8');

      for (const statement of splitStatements(sql)) {
        const bare = statement
          .replace(/--[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim();
        if (bare === '') continue;

        const creates = /^CREATE\s/i.test(bare);
        const drops = /^DROP\s/i.test(bare);
        const guarded = /IF\s+(NOT\s+)?EXISTS/i.test(bare);
        // `VALIDATE CONSTRAINT` on an already-valid constraint is a no-op, so it
        // needs no guard of its own.
        const validates = /VALIDATE\s+CONSTRAINT/i.test(bare);

        if ((creates || drops) && !guarded && !validates) {
          offenders.push(`${file}: ${bare.slice(0, 70)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * A file here that does not need to be here is a file that should have been an
   * ordinary Prisma migration, where it would run in a transaction and be
   * rollback-safe. This directory trades that away for the ability to avoid a
   * lock, and the trade is only worth making when the lock is the problem.
   */
  it('all contain something that genuinely cannot run in a transaction', () => {
    for (const file of files) {
      const sql = readFileSync(join(DIR, file), 'utf8');
      expect(sql, `${file} has no CONCURRENTLY — it belongs in a Prisma migration`).toMatch(
        /CONCURRENTLY/i,
      );
    }
  });
});
