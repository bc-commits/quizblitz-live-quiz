// End-to-end browser test (npm run test:e2e). Starts the real server on a throw-away
// data directory; audio plays muted-friendly thanks to the autoplay flag.
const { defineConfig, devices } = require('@playwright/test');
const os = require('os');
const path = require('path');

const PORT = 3456;
const DATA_DIR = path.join(os.tmpdir(), `blindtest-e2e-${Date.now()}`);

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 180000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: { PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@e2e.local', ADMIN_PASSWORD: 'e2e-password-1234', NODE_ENV: 'test' },
  },
});
