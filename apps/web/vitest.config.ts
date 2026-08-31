import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The `@/` alias Next resolves from tsconfig. Vitest does not read tsconfig
    // paths on its own, and without this the gateway test cannot import the
    // module it exists to test.
    alias: { '@': resolve(here, 'src') },
  },
  test: {
    /**
     * Serial: the gateway test talks to a real PostgreSQL and creates its own
     * tenant. The other suites here are pure, and lose nothing by waiting.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
