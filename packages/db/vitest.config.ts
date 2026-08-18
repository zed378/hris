import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Uji isolasi tenant berbicara ke PostgreSQL sungguhan dan berbagi tabel.
    // Menjalankannya berurutan menghilangkan kegagalan semu yang menyita waktu
    // jauh lebih banyak daripada paralelisme yang dihematnya.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
