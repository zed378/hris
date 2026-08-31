import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/**
 * The frontend must stay reachable only through the public API (PLAN/14 §11).
 *
 * §11 records splitting the frontend from the backend as blocked on a
 * precondition — "no page component reaches into a route handler's module, and
 * all server-side data fetching goes through the public API" — and states that
 * it "is not true today".
 *
 * **Measured, it is true today.** Not one `.tsx` file under `src/` imports
 * `@hrms/core`, `@hrms/db`, or `@hrms/cache` for a value; every page is a client
 * component fetching through `api()`; and the only three server components
 * import nothing but React, a provider, and a stylesheet.
 *
 * The property was arrived at by habit rather than by a rule, which means nothing
 * was stopping the next page from breaking it — and one page reading the database
 * directly turns stage 8 from a deployment change back into a refactor. This file
 * is that rule.
 *
 * It is a test rather than an eslint policy because what it asserts is a fact
 * about a whole directory — "no file anywhere does this" — and a lint rule can
 * only ever speak about the files it is pointed at.
 *
 * ## Line-based, and deliberately not regex
 *
 * The first version built its patterns with `new RegExp` and template literals.
 * The escapes did not survive the file being written, so the pattern became
 * `froms+` and matched nothing at all — the suite passed with the guard doing
 * nothing. It was caught by adding a deliberate violation and watching the tests
 * stay green, which is the only way that class of failure is ever caught.
 */

/** Every `.tsx` under `src/`, which is exactly the frontend. */
function components(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) components(path, found);
    else if (entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

const FILES = components(SRC);

/** Packages that only exist server-side. */
const SERVER_ONLY = ['@hrms/core', '@hrms/db', '@hrms/cache'];

/** The import lines of one file, joined continuations included. */
function importLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import ') || line.startsWith('} from '));
}

describe('the frontend is API-only', () => {
  it('finds components to check at all', () => {
    // Guards the guard: a wrong path would make every assertion below pass over
    // an empty list, which is the quietest way for a test to stop testing.
    expect(FILES.length).toBeGreaterThan(20);
  });

  /**
   * The property that makes stage 8 a deployment change rather than a rewrite.
   *
   * A page importing `@hrms/db` works perfectly in the monolith and cannot be
   * deployed separately at all — and the failure appears at the moment of the
   * split, in whatever page nobody thought to check.
   */
  it('has no component importing a server-only package', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const line of importLines(readFileSync(file, 'utf8'))) {
        // A type-only import is erased at build time and couples nothing.
        if (line.startsWith('import type ')) continue;

        for (const pkg of SERVER_ONLY) {
          if (line.includes(`'${pkg}'`) || line.includes(`'${pkg}/`)) {
            offenders.push(`${relative(SRC, file)} → ${pkg}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no component importing a route handler', () => {
    const offenders = FILES.filter((file) =>
      importLines(readFileSync(file, 'utf8')).some((line) => line.includes('app/api/')),
    ).map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  /**
   * The route manifest belongs to the gateway.
   *
   * A page reading it would decide what it may do from the same table the server
   * uses to decide — which sounds tidy and quietly turns P9 ("the screen hides,
   * the server refuses") into one decision made twice from one source, so a
   * mistake in it stops being caught by the second layer.
   */
  it('has no component importing the route manifest', () => {
    const offenders = FILES.filter((file) =>
      importLines(readFileSync(file, 'utf8')).some((line) => line.includes('route-manifest')),
    ).map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});
