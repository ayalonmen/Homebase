// playwright.config.js — E2E config for the Life Management Dashboard.
//
// Points at the same http://127.0.0.1:3000 the app is normally served on
// (see package.json's serve:web). e2e/run-e2e.ps1 is responsible for
// actually starting the app against a fresh seeded PocketBase before
// Playwright runs — this config assumes it's already up, it doesn't start
// anything itself.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
