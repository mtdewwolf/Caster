import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import {
  E2E_ADMIN_PASSWORD,
  E2E_BASE_URL,
  E2E_PORT,
  getE2ERuntimePaths
} from './tests/e2e/constants';

const runtime = getE2ERuntimePaths();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: path.join(runtime.playwrightRoot, 'artifacts'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'line',
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'bun run test:e2e:serve',
    cwd: process.cwd(),
    url: `${E2E_BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      PORT: E2E_PORT.toString(),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
      MEDIA_DATA_DIR: runtime.dataDir,
      THUMBNAILS_DIR: runtime.thumbnailsDir,
      TRANSCODE_CACHE_DIR: runtime.transcodeCacheDir,
      CASTER_E2E_RUNTIME_DIR: runtime.runtimeRoot
    }
  }
});
