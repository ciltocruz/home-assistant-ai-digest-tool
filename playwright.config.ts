import { defineConfig, devices } from '@playwright/test';

const SMOKE_HOST = '127.0.0.1';
const SMOKE_PORT = 4173;
const SMOKE_BASE_URL = `http://${SMOKE_HOST}:${SMOKE_PORT}`;

export default defineConfig({
  testDir: './tests/smoke',
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: SMOKE_BASE_URL,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `pnpm -C frontend dev --host ${SMOKE_HOST} --port ${SMOKE_PORT}`,
    url: SMOKE_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
