import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. They are not parallelizable per worker because
// each worker spins up its own browser context anyway.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Don't record a trace unless a test is being retried. `retain-on-failure`
  // records one for EVERY test and throws it away on pass, and the suite
  // shares a single worker-scoped browser context across all its tests
  // (tests/fixtures/extension.ts) — recording against a context that
  // long-lived eventually stalls the trace fixture past its own 30s setup
  // timeout, failing whichever test happens to be next.
  use: {
    trace: 'on-first-retry',
  },
});
