/**
 * Before any test: the operator account, and its session saved for every test (`storageState`). The data directory is
 * fresh, so the account is made through the setup; name and password are made up for the test run and live only in
 * the temporary data directory.
 */
import { request, type FullConfig } from '@playwright/test'

export const OPERATOR = { name: 'tester', password: 'e2e test operator password' }
/** The setup code the test server is started with (playwright.config.ts); a real one is in the server's log. */
export const SETUP_CODE = 'e2e-setup-code'
export const TAB = { 'X-Nextasks-Client': 'tab-e2esetup0' }

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL!
  const context = await request.newContext({ baseURL, extraHTTPHeaders: TAB })
  const made = await context.post('/api/setup', { data: { name: OPERATOR.name, password: OPERATOR.password, language: 'en', code: SETUP_CODE } })
  if (!made.ok()) throw new Error(`setup failed: ${made.status()} ${await made.text()}`)
  await context.storageState({ path: process.env.NEXTASKS_E2E_STATE! })
  await context.dispose()
}
