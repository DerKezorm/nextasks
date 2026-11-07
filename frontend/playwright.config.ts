/**
 * End-to-end, headless: the sign-in through providers (e2e/nexoidc.spec.ts, the shared sign-in blueprint's
 * Pflichttests 33 and 34). The built frontend is served by the real backend, as in the container, with a fresh data
 * directory and its own port, so a running development server is never measured; the provider is the stand-in of
 * e2e/fake-provider.mjs.
 *
 *   npm run e2e        build, start backend (8511) and stand-in provider (8519), test
 */
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 8511
const PROVIDER_PORT = 8519

/** A fresh data directory per run; the workers load this file again and inherit it through the environment. */
function dataDir(): string {
  if (process.env.NEXTASKS_E2E_DATA) return process.env.NEXTASKS_E2E_DATA
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextasks-e2e-'))
  process.env.NEXTASKS_E2E_DATA = dir
  return dir
}

const DATA_DIR = dataDir()
/** Where the operator's session is kept for the tests (global-setup.ts signs in once). */
export const SIGNED_IN = path.join(DATA_DIR, 'e2e-operator.json')
process.env.NEXTASKS_E2E_STATE = SIGNED_IN
// The project's venv on the development machines, the system Python in CI.
const venv = path.join('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = fs.existsSync(path.join('..', 'backend', venv)) ? venv : 'python'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    locale: 'en-US',
    storageState: SIGNED_IN,
  },
  webServer: [
    {
      command: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT}`,
      cwd: path.join('..', 'backend'),
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NEXTASKS_DATA_DIR: DATA_DIR,
        NEXTASKS_FRONTEND_DIST: path.resolve('dist'),
        NEXTASKS_DISABLE_BACKGROUND: '1',
        // The tests make and sign in accounts; Argon2's strength is not what they measure.
        NEXTASKS_ARGON2_TIME: '1',
        NEXTASKS_ARGON2_MEMORY_KIB: '8192',
        NEXTASKS_ARGON2_PARALLELISM: '1',
        // Never GitHub from a test: port 9 refuses at once.
        NEXTASKS_UPDATE_URL: 'http://127.0.0.1:9/releases/latest',
        // The code the first account brings; global-setup.ts sends it.
        NEXTASKS_SETUP_TOKEN: 'e2e-setup-code',
      },
    },
    {
      command: 'node e2e/fake-provider.mjs',
      url: `http://127.0.0.1:${PROVIDER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 20_000,
      env: { FAKE_PROVIDER_PORT: String(PROVIDER_PORT) },
    },
  ],
})
