import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Tools resolve paths against process.cwd(); run each test file in a forked
    // process so process.chdir() is allowed (it is not in worker threads).
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['test/**', 'dist/**'],
    },
  },
});
