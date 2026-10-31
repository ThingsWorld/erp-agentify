import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 并发与多进程测试自己起子进程，vitest 这层串行跑，避免两层并发互相干扰。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
