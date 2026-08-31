import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Serial, because several suites here talk to a real PostgreSQL.
     *
     * They create their own tenants with random UUIDs so they do not collide on
     * data, but they do share a connection pool and a set of tables. Running
     * them in parallel buys a second or two and costs an afternoon the first
     * time a false failure has to be reproduced.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
