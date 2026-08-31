import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Module boundaries as a CI gate (PLAN/12 §3.1 rule 1).
 *
 * This is the most important file in the repository for the system's longevity,
 * and its reason is not visible from its contents.
 *
 * This plan chose a modular monolith on the promise that splitting it into
 * services later takes 4–6 weeks per service rather than 4–6 months. That
 * promise only holds while every module genuinely communicates through its
 * public API. Without machine enforcement the boundary erodes — not because
 * anyone deliberately breaks it, but because importing one function from deep
 * inside another module always feels like a reasonable shortcut on the day.
 *
 * Once the boundary has eroded, there is no single commit to point at as the
 * cause, and §9 quietly turns from a plan into a hope.
 *
 * Its core rule is one sentence: **a module's internals may only touch their own
 * module's internals; other modules only through `index.ts`.**
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
      // `mode: 'file'` carries the weight here and must not be removed even
      // though the plugin warns it is deprecated — that warning targets the
      // 'full' and 'folder' modes. Without 'file', the `*/index.ts` pattern is
      // matched as a folder, `index.ts` stops being recognised as a front door,
      // and the whole policy collapses into "every cross-module import is
      // forbidden" — failing loudly, fortunately, rather than quietly allowing.
      'boundaries/elements': [
        // Order matters: `index.ts` matches both patterns below, and the first
        // definition wins. The front door has to be recognised first.
        {
          type: 'core-module-api',
          mode: 'file',
          pattern: 'packages/core/src/*/index.ts',
          capture: ['module'],
        },
        {
          type: 'core-module-internal',
          mode: 'file',
          pattern: 'packages/core/src/*/**',
          capture: ['module'],
        },
        { type: 'db', mode: 'file', pattern: 'packages/db/src/**' },
        { type: 'contracts', mode: 'file', pattern: 'packages/contracts/src/**' },
        { type: 'observability', mode: 'file', pattern: 'packages/observability/src/**' },
        // Shared Redis-backed state: rate-limit counters, and the permission
        // cache the auth split needs. A leaf like observability — it depends on
        // nothing above it, so both the backend and the auth service can hold it
        // without either depending on the other.
        { type: 'cache', mode: 'file', pattern: 'packages/cache/src/**' },
        { type: 'app', mode: 'file', pattern: 'apps/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Applications use a module through its front door. An import of an
            // internal path such as '@hrms/core/auth/login.ts' is refused here.
            {
              from: [{ element: { type: 'app' } }],
              allow: [
                { to: { element: { type: 'core-module-api' } } },
                { to: { element: { type: 'db' } } },
                { to: { element: { type: 'contracts' } } },
                { to: { element: { type: 'observability' } } },
                { to: { element: { type: 'cache' } } },
                { to: { element: { type: 'app' } } },
              ],
            },

            // Module internals: free within their own module, front door only to
            // other modules. This is the rule that makes a future split merely a
            // matter of turning a function call into HTTP.
            {
              from: [{ element: { type: 'core-module-internal' } }],
              allow: [
                { to: { element: { type: 'core-module-api' } } },
                { to: { element: { type: 'cache' } } },
                {
                  to: {
                    element: {
                      type: 'core-module-internal',
                      captured: { module: '{{from.module}}' },
                    },
                  },
                },
                { to: { element: { type: 'db' } } },
                { to: { element: { type: 'contracts' } } },
                { to: { element: { type: 'observability' } } },
              ],
            },

            // A module's front door summarises its own internals, and may forward
            // to another module's front door.
            {
              from: [{ element: { type: 'core-module-api' } }],
              allow: [
                { to: { element: { type: 'core-module-api' } } },
                {
                  to: {
                    element: {
                      type: 'core-module-internal',
                      captured: { module: '{{from.module}}' },
                    },
                  },
                },
                { to: { element: { type: 'db' } } },
                { to: { element: { type: 'contracts' } } },
                { to: { element: { type: 'observability' } } },
              ],
            },

            // A lower layer never knows about the layers above it.
            //
            // `contracts` is a deliberate exception: it is a true leaf — it may
            // only import itself — so `db` depending on it keeps the graph
            // acyclic. What that buys is the event topic catalogue being usable
            // as the TYPE of `publishEvent`'s parameter, rather than a naming
            // convention everyone is expected to follow.
            // dipatuhi.
            {
              from: [{ element: { type: 'db' } }],
              allow: [{ to: { element: { type: 'db' } } }, { to: { element: { type: 'contracts' } } }],
            },
            {
              from: [{ element: { type: 'contracts' } }],
              allow: [{ to: { element: { type: 'contracts' } } }],
            },
            // Observability is the lowest leaf: every layer may log, and it must
            // not depend on any of them. A dependency the other way would make
            // the logger fail along with the layer it is meant to be logging.
            {
              from: [{ element: { type: 'observability' } }],
              allow: [{ to: { element: { type: 'observability' } } }],
            },

            // Cache sits beside observability: it may log, and nothing else.
            {
              from: [{ element: { type: 'cache' } }],
              allow: [
                { to: { element: { type: 'cache' } } },
                { to: { element: { type: 'observability' } } },
              ],
            },
          ],
        },
      ],

      // A domain module must not import Prisma directly — all database access
      // goes through @hrms/db, because that is where the tenant context is set. A
      // path that bypasses it is a path without RLS.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Pakai @hrms/db. Akses Prisma langsung melewati withTenant(), dan karenanya melewati konteks RLS.',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  /**
   * The gateway authorizes through ONE function (PLAN/14 stage 4).
   *
   * `decideAccess` is the seam that becomes a call to the auth service. A route
   * that reached for `resolveEffectiveAccess` instead would be composing the
   * decision for itself — its own order of staleness, subscription, and
   * permission checks — and when authorization moves across the network that
   * route would silently keep asking the old question.
   *
   * The failure mode is the reason this is a lint rule rather than a convention:
   * such a route works perfectly until the day of the split, and then answers
   * differently from every other route in a way no test asks about.
   *
   * `apps/web` only. Inside `packages/core` the two are neighbours, and
   * `decideAccess` is built from `resolveEffectiveAccess`.
   */
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores: ['apps/web/test/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Pakai @hrms/db. Akses Prisma langsung melewati withTenant(), dan karenanya melewati konteks RLS.',
            },
            {
              name: '@hrms/core/iam',
              importNames: ['resolveEffectiveAccess'],
              message:
                'Pakai decideAccess(). Ia adalah sambungan yang kelak menjadi panggilan ke service auth ' +
                '(PLAN/14 tahap 4), dan ia yang memegang urutan pemeriksaan: basi, langganan, lalu izin.',
            },
          ],
        },
      ],
    },
  },

  // @hrms/db is the only place allowed to touch Prisma. It is its wrapper.
  {
    files: ['packages/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Seeds, tests, and ops scripts run outside the request cycle.
  {
    files: [
      'packages/db/prisma/**/*.ts',
      '**/test/**/*.ts',
      'ops/**/*.mjs',
      '**/*.config.ts',
    ],
    rules: { 'boundaries/dependencies': 'off', 'no-console': 'off' },
  },

  /**
   * Tests may hold an owner-privileged Prisma client. Only tests.
   *
   * The rule above exists because a path that reaches Prisma directly is a path
   * that never set `app.tenant_id`, and therefore a path without RLS. That
   * reasoning is about code that serves requests, and it does not transfer to a
   * test that has to CREATE the tenants it then queries as an ordinary caller —
   * `tenant.tenants` is itself RLS-protected, so there is no way to arrange that
   * fixture from inside a tenant context.
   *
   * The narrowness is the safeguard. This applies to `test/` directories only,
   * nothing in `src/` is covered by it, and the tests that use it are expected to
   * do their SETUP with the owner client and their ASSERTIONS through
   * `withTenant` — otherwise they would be proving that PostgreSQL can read rows
   * rather than that the application can.
   */
  {
    files: ['**/test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
