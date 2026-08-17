import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'backend/**/*.test.ts', 'frontend/**/*.test.ts', 'frontend/**/*.test.tsx', 'tests/**/*.test.ts'],
    forbidOnly: true,
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['backend/src/**/*.ts', 'frontend/src/**/*.{ts,tsx}', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/dist/**', '**/node_modules/**']
    }
  }
});
