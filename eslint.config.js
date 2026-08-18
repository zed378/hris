import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Batas modul sebagai gerbang CI (PLAN/12 §3.1 aturan 1).
 *
 * Ini berkas terpenting dalam repositori untuk umur panjang sistem, dan alasannya
 * tidak terlihat dari isinya.
 *
 * Rencana ini memilih monolit modular dengan janji bahwa memecahnya menjadi
 * service kelak memakan 4–6 minggu per service, bukan 4–6 bulan. Janji itu hanya
 * benar bila setiap modul benar-benar berkomunikasi lewat API publiknya. Tanpa
 * penegakan mesin, batas itu akan luntur — bukan karena ada yang sengaja
 * melanggarnya, melainkan karena mengimpor satu fungsi dari kedalaman modul lain
 * selalu terasa seperti jalan pintas yang wajar pada hari itu.
 *
 * Ketika batasnya sudah luntur, tidak ada satu commit pun yang dapat ditunjuk
 * sebagai penyebabnya, dan §9 diam-diam berubah dari rencana menjadi harapan.
 *
 * Aturan intinya satu kalimat: **isi sebuah modul hanya boleh menyentuh isi
 * modulnya sendiri; ke modul lain hanya lewat `index.ts`.**
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
      // `mode: 'file'` memikul beban di sini dan tidak boleh dihapus meski
      // plugin memperingatkannya sebagai deprecated — peringatan itu menyasar
      // mode 'full' dan 'folder'. Tanpa 'file', pola `*/index.ts` dicocokkan
      // sebagai folder, `index.ts` berhenti dikenali sebagai pintu depan, dan
      // seluruh kebijakan runtuh menjadi "semua impor lintas modul dilarang" —
      // gagal keras, untungnya, bukan diam-diam mengizinkan.
      'boundaries/elements': [
        // Urutan penting: `index.ts` cocok dengan kedua pola di bawah, dan
        // definisi pertama yang menang. Pintu depan harus dikenali lebih dulu.
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
        { type: 'app', mode: 'file', pattern: 'apps/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Aplikasi memakai modul lewat pintu depannya. Impor ke jalur dalam
            // seperti '@hrms/core/auth/login.ts' ditolak di sini.
            {
              from: [{ element: { type: 'app' } }],
              allow: [
                { to: { element: { type: 'core-module-api' } } },
                { to: { element: { type: 'db' } } },
                { to: { element: { type: 'contracts' } } },
                { to: { element: { type: 'app' } } },
              ],
            },

            // Isi modul: bebas di dalam modulnya sendiri, hanya pintu depan ke
            // modul lain. Inilah aturan yang membuat pemisahan kelak sekadar
            // mengganti pemanggilan fungsi menjadi HTTP.
            {
              from: [{ element: { type: 'core-module-internal' } }],
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
              ],
            },

            // Pintu depan sebuah modul merangkum isinya sendiri, dan boleh
            // meneruskan ke pintu depan modul lain.
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
              ],
            },

            // Lapisan bawah tidak pernah tahu tentang lapisan di atasnya.
            { from: [{ element: { type: 'db' } }], allow: [{ to: { element: { type: 'db' } } }] },
            {
              from: [{ element: { type: 'contracts' } }],
              allow: [{ to: { element: { type: 'contracts' } } }],
            },
          ],
        },
      ],

      // Modul domain tidak boleh mengimpor Prisma langsung — seluruh akses basis
      // data lewat @hrms/db, karena di situlah konteks tenant dipasang. Jalur
      // yang melewatinya adalah jalur tanpa RLS.
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

  // @hrms/db adalah satu-satunya tempat yang boleh menyentuh Prisma. Ia memang
  // pembungkusnya.
  {
    files: ['packages/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Seed, uji, dan skrip ops berjalan di luar siklus request.
  {
    files: [
      'packages/db/prisma/**/*.ts',
      '**/test/**/*.ts',
      'ops/**/*.mjs',
      '**/*.config.ts',
    ],
    rules: { 'boundaries/dependencies': 'off', 'no-console': 'off' },
  },
);
