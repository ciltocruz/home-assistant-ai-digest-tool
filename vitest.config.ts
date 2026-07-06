import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'backend/**/*.test.ts', 'frontend/**/*.test.ts', 'tests/**/*.test.ts'],
    forbidOnly: true,
    globals: false
  }
});
