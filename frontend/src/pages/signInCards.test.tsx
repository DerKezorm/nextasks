// Settings, Server, Sign-in as the shared sign-in blueprint lays it out (part 04): three cards, the provider form as a
// dialog with its fields in the blueprint's order, adding, editing and removing with the question that names the
// accounts, and the steps of the authentik button by their names with
// the reason of a failure. The step names and reasons come from the shared module (`STEP_KEYS`, `REASONS` in
// backend/app/vendor/nexoidc/authentik.py), so a name the language files lack shows up here, not on the operator's
// screen.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OidcProvider } from '../api/client'
import i18n from '../i18n'
import oidcDe from '../vendor/nexoidc/oidc.de.json'
import oidcEn from '../vendor/nexoidc/oidc.en.json'
import { calls, emptyAddress, fake, hold, resetFake } from '../test/legacy'
import { button, click, mount, settle, type, unmount } from '../test/legacyHarness'
import { useServerSettings } from './settings/ServerCards'
import { SignInPart } from './settings/SignInCards'

vi.mock('../api/client', async (importOriginal) => (await import('../test/legacy')).clientMock(await importOriginal()))
/** Whether the operator has an own second factor; the requirement switch shows another hint without one. */
const viewer = vi.hoisted(() => ({ two_factor: true }))
vi.mock('../state/auth', async () => {
  const mock = (await import('../test/legacyHarness')).authMock()
  return { ...mock, useAuth: () => ({ ...mock.useAuth(), me: { ...mock.useAuth().me, sign_in: 'password', two_factor: viewer.two_factor } }) }
})

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

const module = files.readFileSync('../backend/app/vendor/nexoidc/authentik.py', 'utf-8')
const tuple = (name: string) => [...(module.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))?.[1] ?? '').matchAll(/"(\w+)"/g)].map((found) => found[1])
const STEP_KEYS = tuple('STEP_KEYS')
const REASONS = tuple('REASONS')
const TEXTS = { de: oidcDe.oidc, en: oidcEn.oidc } as const
type Language = keyof typeof TEXTS

beforeEach(() => {
  resetFake()
  viewer.two_factor = true
})
afterEach(unmount)

function SignIn() {
  const server = useServerSettings()
  return <SignInPart server={server} />
}

function entry(change: Partial<OidcProvider> = {}): OidcProvider {
  return { id: 7, slug: 'sso', label: 'Firma SSO', issuer: 'https://sso.example.com', client_id: 'nextasks', has_secret: true, scopes: 'openid profile email', enabled: true, auto_create: false, trusts_second_factor: true, managed: '', position: 0, redirect_uri: 'https://tasks.example.com/api/oidc/sso/callback', links: 2, editable: true, ...change }
}

async function page(language: Language = 'en'): Promise<HTMLElement> {
  fake.settings = { password_login: true, two_factor_required: false, public_url: 'https://tasks.example.com' }
  const shown = await mount(<SignIn />)
  await act(async () => {
    await i18n.changeLanguage(language)
  })
  await settle()
  return shown
}

const headings = (shown: HTMLElement) => [...shown.querySelectorAll('h2')].map((heading) => heading.textContent)
const labels = (shown: ParentNode) =>
  [...shown.querySelectorAll('label span:first-child, [data-testid="provider-form"] > div > span')]
    .map((label) => label.textContent)
    .filter((label, index, all) => label !== all[index - 1])
const rows = (shown: HTMLElement) => [...shown.querySelectorAll('[data-testid="authentik-steps"] li')].map((row) => row.textContent)
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement

describe('Settings, Server, Sign-in', () => {
  it.each(['en', 'de'] as const)('has three cards in %s, the empty list says what to do', async (language) => {
    const shown = await page(language)
    const words = TEXTS[language]
    expect(headings(shown)).toEqual([words.admin.signInTitle, words.admin.providersTitle, words.authentik.title])
    expect(shown.textContent).toContain(words.admin.empty)
    // No provider active: the password sign-in cannot be turned off.
    const password = shown.querySelector(`input[aria-label="${words.admin.password}"]`) as HTMLInputElement
    expect(password.checked && password.disabled).toBe(true)
  })

  it('opens the form as a dialog with the fields in the order of the blueprint', async () => {
    const shown = await page()
    await click(button(shown, oidcEn.oidc.admin.add))
    const words = oidcEn.oidc.admin
    const order = labels(dialog()).filter((label) => label && [words.label, words.slug, words.issuer, words.clientId, words.secret, words.redirect, words.enabled, words.autoCreate, words.trustsSecondFactor].includes(label))
    expect(order).toEqual([words.label, words.slug, words.issuer, words.clientId, words.secret, words.redirect, words.enabled, words.autoCreate, words.trustsSecondFactor])
    // The short name follows the name on the button, and the redirect address with it.
    await type(dialog().querySelector('input'), 'Microsoft Entra')
    expect((dialog().querySelectorAll('input')[1] as HTMLInputElement).value).toBe('microsoft-entra')
    expect(dialog().textContent).toContain(words.slugHint)
    expect((dialog().querySelector(`input[aria-label="${words.redirect}"]`) as HTMLInputElement).value).toBe('https://tasks.example.com/api/oidc/microsoft-entra/callback')
    // Off from the start: new people; on: the provider checks the second factor.
    expect((dialog().querySelector(`input[aria-label="${words.autoCreate}"]`) as HTMLInputElement).checked).toBe(false)
    expect((dialog().querySelector(`input[aria-label="${words.trustsSecondFactor}"]`) as HTMLInputElement).checked).toBe(true)
  })

  it('adds a provider through the dialog, with the defaults of the blueprint', async () => {
    const shown = await page()
    const words = oidcEn.oidc.admin
    await click(button(shown, words.add))
    const inputs = () => [...dialog().querySelectorAll('input')] as HTMLInputElement[]
    await type(inputs()[0], 'Firma SSO')
    await type(inputs()[2], 'https://sso.example.com/')
    await type(inputs()[3], 'nextasks')
    await click(button(dialog(), i18n.t('common.save')))
    await settle()
    expect(calls('addProvider')[0].args[0]).toMatchObject({ label: 'Firma SSO', slug: 'firma-sso', issuer: 'https://sso.example.com/', enabled: true, auto_create: false, trusts_second_factor: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(shown.querySelector('[data-testid="provider-list"]')?.textContent).toContain('Firma SSO')
  })

  it('edits a provider, asks before another issuer, and removes it naming the accounts', async () => {
    fake.providers = [entry({ links: 3 })]
    const shown = await page()
    const words = oidcEn.oidc.admin
    const inputs = () => [...dialog().querySelectorAll('input')] as HTMLInputElement[]
    await click(button(shown, words.edit))
    expect(dialog().textContent).toContain('sso')
    await type(inputs()[1], 'https://other.example.com')
    await click(button(dialog(), i18n.t('common.save')))
    await settle()
    // Another issuer with linked accounts: the question names how many must link again, and nothing is saved yet.
    expect(document.body.textContent).toContain(i18n.t('oidc.admin.issuerChangeConfirm', { count: 3 }))
    expect(calls('saveProvider')).toHaveLength(0)
    await click(button(document.querySelectorAll('[role="dialog"]')[1] as HTMLElement, i18n.t('common.cancel')))
    // The same issuer with a slash at the end is no other issuer: saved without a question.
    fake.calls = []
    await type(inputs()[1], 'https://sso.example.com/')
    await type(inputs()[0], 'Firma SSO 2')
    await click(button(dialog(), i18n.t('common.save')))
    await settle()
    expect(calls('providerImpact')).toHaveLength(0)
    expect(calls('saveProvider')).toHaveLength(1)
    expect(calls('saveProvider')[0].args[1]).toMatchObject({ client_secret: '' })
    expect(shown.querySelector('[data-testid="provider-list"]')?.textContent).toContain('Firma SSO 2')
    fake.providers[0].links = 3
    await click(button(shown, words.remove))
    await settle()
    expect(dialog().textContent).toContain(i18n.t('oidc.admin.removeConfirm', { name: 'Firma SSO 2', count: 3, only: 0 }))
    await click(button(dialog(), words.remove))
    await settle()
    expect(calls('removeProvider')).toHaveLength(1)
    expect(shown.textContent).toContain(words.empty)
  })

  it('shows a form error at its field in the words of the module', async () => {
    const shown = await page('de')
    await click(button(shown, oidcDe.oidc.admin.add))
    fake.refuse.addProvider = { status: 422, code: 'oidc_issuer_mismatch', values: { field: 'issuer' } }
    await click(button(dialog(), i18n.t('common.save')))
    await settle()
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(oidcDe.oidc.error.oidc_issuer_mismatch)
  })

  it('marks the entries: on or off, set up through authentik', async () => {
    fake.providers = [entry({ managed: 'authentik' }), entry({ id: 8, slug: 'entra', label: 'Microsoft', enabled: false, links: 0 })]
    const shown = await page()
    const list = shown.querySelector('[data-testid="provider-list"]')!.textContent
    expect(list).toContain(oidcEn.oidc.admin.managed)
    expect(list).toContain(oidcEn.oidc.admin.active)
    expect(list).toContain(oidcEn.oidc.admin.inactive)
    // Two entries: each has its drag handle.
    expect(shown.querySelectorAll('[data-testid="provider-list"] button[aria-label]')).toHaveLength(2)
  })

})

describe('the authentik steps', () => {
  it('come from the module, and each has a name and each reason a sentence in both languages', () => {
    expect(STEP_KEYS).toEqual(['reached', 'signingKey', 'mapping', 'provider', 'application', 'filled'])
    expect(REASONS).toContain('coupled')
    for (const language of ['de', 'en'] as const) {
      for (const key of STEP_KEYS) expect(TEXTS[language].authentik.step[key as keyof typeof oidcEn.oidc.authentik.step], key).toBeTruthy()
      for (const reason of REASONS) {
        // A reason with a number is two sentences, one and other (since 1.0.9), asked without the ending and with a count.
        const why = TEXTS[language].authentik.why as Record<string, string>
        const sentences = reason in why ? [why[reason]] : [why[`${reason}_one`], why[`${reason}_other`]]
        for (const sentence of sentences) expect(sentence, reason).toBeTruthy()
      }
    }
  })

  async function card(language: Language): Promise<HTMLElement> {
    const shown = await page(language)
    await type(shown.querySelector('input[placeholder="https://auth.example.com"]'), 'https://auth.example.com')
    await type([...shown.querySelectorAll('input[type="password"]')].at(-1), 'token')
    return shown
  }

  it.each(['en', 'de'] as const)('are named in %s; after everything worked the token goes', async (language) => {
    fake.authentikSteps = STEP_KEYS.map((key) => ({ key, ok: true, detail: `found ${key}` }))
    const shown = await card(language)
    await click(button(shown, TEXTS[language].authentik.run))
    await settle()
    const names: Record<string, string> = TEXTS[language].authentik.step
    expect(rows(shown)).toEqual(STEP_KEYS.map((key) => `✓${names[key]}`))
    expect(([...shown.querySelectorAll('input[type="password"]')].at(-1) as HTMLInputElement).value).toBe('')
  })

  it.each(['en', 'de'] as const)('say in %s why a step failed, never the technical line, and keep the token', async (language) => {
    const detail = 'POST /crypto/certificatekeypairs/generate/ answered 403 (application/json); the log has the answer'
    fake.authentikSteps = [
      { key: STEP_KEYS[0], ok: true, detail: 'authentik 2026.8.1' },
      { key: STEP_KEYS[1], ok: false, detail, reason: 'token', status: 403 },
    ]
    const shown = await card(language)
    await click(button(shown, TEXTS[language].authentik.run))
    await settle()
    const names: Record<string, string> = TEXTS[language].authentik.step
    const why = TEXTS[language].authentik.why.token.replace('{{status}}', '403')
    expect(rows(shown)).toEqual([`✓${names[STEP_KEYS[0]]}`, `✗${names[STEP_KEYS[1]]}${why}`])
    expect(shown.textContent).not.toContain(detail)
    expect(([...shown.querySelectorAll('input[type="password"]')].at(-1) as HTMLInputElement).value).toBe('token')
  })

  it('says authentik is being asked while the run is under way, and the last answer goes first', async () => {
    fake.authentikSteps = [{ key: STEP_KEYS[0], ok: false, detail: 'not reachable', reason: 'unreachable', status: 0 }]
    const shown = await card('en')
    await click(button(shown, oidcEn.oidc.authentik.run))
    await settle()
    expect(rows(shown)).toHaveLength(1)
    const release = hold('authentik')
    await click(button(shown, oidcEn.oidc.authentik.run))
    expect(shown.querySelector('[role="status"]')?.textContent).toBe(oidcEn.oidc.authentik.asking)
    expect(rows(shown)).toEqual([])
    release()
    await settle()
    expect(shown.querySelector('[role="status"]')).toBeNull()
    expect(rows(shown)).toEqual([`✗${oidcEn.oidc.authentik.step.reached}${oidcEn.oidc.authentik.why.unreachable.replace('{{app}}', 'nextasks')}`])
  })

  it('asks before another issuer takes the links, runs once more on yes and changes nothing on no', async () => {
    const asking = (count: number) => ({ steps: [{ key: STEP_KEYS[0], ok: false, detail: 'would change', reason: 'issuer_change', status: 0 }], count })
    fake.authentikRuns = [asking(3), { steps: STEP_KEYS.map((key) => ({ key, ok: true, detail: `found ${key}` })) }, asking(2)]
    const shown = await card('en')
    await click(button(shown, oidcEn.oidc.authentik.run))
    await settle()
    // The question, in the shared words with the number; no failure line behind it; nothing but the question was sent.
    expect(dialog().textContent).toContain(i18n.t('oidc.admin.issuerChangeConfirm', { count: 3 }))
    expect(rows(shown)).toEqual([])
    expect(calls('authentik').map((call) => (call.args[0] as { confirm_issuer_change: boolean }).confirm_issuer_change)).toEqual([false])
    await click(button(dialog(), oidcEn.oidc.authentik.run))
    await settle()
    expect(calls('authentik').map((call) => (call.args[0] as { confirm_issuer_change: boolean }).confirm_issuer_change)).toEqual([false, true])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(rows(shown)).toHaveLength(STEP_KEYS.length)
    // Every new run asks again; No leaves it at that.
    await type([...shown.querySelectorAll('input[type="password"]')].at(-1), 'token again')
    await click(button(shown, oidcEn.oidc.authentik.run))
    await settle()
    expect(dialog().textContent).toContain(i18n.t('oidc.admin.issuerChangeConfirm', { count: 2 }))
    await click(button(dialog(), i18n.t('common.cancel')))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls('authentik')).toHaveLength(3)
  })

  it('proposes the address of the browser without a public address and sets up with it', async () => {
    fake.address = emptyAddress({ public_url: '' })
    fake.settings = { password_login: true, two_factor_required: false, public_url: '' }
    fake.authentikSteps = STEP_KEYS.map((key) => ({ key, ok: true, detail: key }))
    const shown = await mount(<SignIn />)
    await settle()
    const words = oidcEn.oidc.authentik
    const note = shown.querySelector('[data-testid="authentik-no-address"]')
    expect(note?.textContent).toContain(words.noAddress.replace('{{app}}', 'nextasks'))
    // The suggestion is the browser's own address, and the redirect address the button would register behind it.
    expect(shown.querySelector('[data-testid="authentik-proposal"]')?.textContent).toBe(window.location.origin)
    expect(note?.textContent).toContain(`${window.location.origin}/api/oidc/authentik/callback`)
    expect(shown.querySelector('[data-testid="authentik-proxy-warning"]')).toBeNull()
    expect(shown.querySelector('[data-testid="authentik-stale"]')).toBeNull()
    // "Use it and set up" replaces "Set up" and sends the suggestion with the run.
    expect(button(shown, words.run)).toBeUndefined()
    await type([...shown.querySelectorAll('input')].find((input) => input.type !== 'password' && input.placeholder === 'https://auth.example.com'), 'https://auth.example.com')
    await type(shown.querySelector('input[type="password"]'), 'a token')
    await click(button(shown, words.adopt))
    await settle()
    expect(calls('authentik')[0].args[0]).toMatchObject({ url: 'https://auth.example.com', confirm_issuer_change: false, public_url: window.location.origin })
    expect(rows(shown)).toHaveLength(STEP_KEYS.length)
  })

  it('warns under the suggestion when the server sees another address than the browser uses', async () => {
    fake.address = emptyAddress({ public_url: '', seen: 'http://tasks-internal:8000' })
    fake.settings = { password_login: true, two_factor_required: false, public_url: '' }
    const shown = await mount(<SignIn />)
    await settle()
    expect(shown.querySelector('[data-testid="authentik-proxy-warning"]')?.textContent).toBe(
      oidcEn.oidc.authentik.proxyWarning.replaceAll('{{app}}', 'nextasks').replace('{{address}}', 'http://tasks-internal:8000'),
    )
  })

  it('uses the suggestion only, and asks first when authentik knows another redirect address', async () => {
    fake.address = emptyAddress({ public_url: '' })
    fake.settings = { password_login: true, two_factor_required: false, public_url: '' }
    fake.addressAsks = { count: 1, address: 'http://old.example.com/api/oidc/authentik/callback', hand: 2 }
    const shown = await mount(<SignIn />)
    await settle()
    await click(button(shown, oidcEn.oidc.authentik.adoptOnly))
    await settle()
    // The question names the redirect address authentik keeps and the entries made by hand; nothing was saved yet.
    const asked = dialog().textContent ?? ''
    expect(asked).toContain(i18n.t('oidc.admin.addressChangeConfirm', { address: fake.addressAsks.address }))
    expect(asked).toContain(i18n.t('oidc.admin.addressChangeHand', { count: 2 }))
    expect(calls('saveAddress').map((call) => (call.args[0] as { confirm: boolean }).confirm)).toEqual([false])
    expect(fake.address.public_url).toBe('')
    await click(button(dialog(), oidcEn.oidc.authentik.adoptOnly))
    await settle()
    expect(calls('saveAddress').map((call) => (call.args[0] as { confirm: boolean }).confirm)).toEqual([false, true])
    expect(fake.address.public_url).toBe(window.location.origin)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // With an address the card has its ordinary button again, and no suggestion.
    expect(shown.querySelector('[data-testid="authentik-no-address"]')).toBeNull()
    expect(button(shown, oidcEn.oidc.authentik.run)).toBeTruthy()
  })

  it('says what authentik still knows after the address changed', async () => {
    fake.address = emptyAddress({ stale: true, registered_redirect_uri: 'http://old.example.com/api/oidc/authentik/callback' })
    const shown = await page()
    expect(shown.querySelector('[data-testid="authentik-stale"]')?.textContent).toBe(
      oidcEn.oidc.authentik.stale.replace('{{address}}', 'http://old.example.com/api/oidc/authentik/callback'),
    )
  })

  it('shows the address the server names when the run stopped for want of one', async () => {
    fake.address = emptyAddress({ public_url: '', seen: 'http://tasks-internal:8000' })
    fake.settings = { password_login: true, two_factor_required: false, public_url: '' }
    fake.authentikRuns = [{ steps: [{ key: STEP_KEYS[0], ok: false, detail: 'none', reason: 'public_url_needed', status: 0 }], address: emptyAddress({ public_url: '', seen: 'http://tasks-internal:8000' }) }]
    const shown = await mount(<SignIn />)
    await settle()
    await type([...shown.querySelectorAll('input')].find((input) => input.placeholder === 'https://auth.example.com'), 'https://auth.example.com')
    await type(shown.querySelector('input[type="password"]'), 'a token')
    await click(button(shown, oidcEn.oidc.authentik.adopt))
    await settle()
    expect(rows(shown)).toEqual([`✗${oidcEn.oidc.authentik.step.reached}${oidcEn.oidc.authentik.why.public_url_needed.replaceAll('{{app}}', 'nextasks')}`])
    expect(shown.querySelector('[data-testid="authentik-proxy-warning"]')).not.toBeNull()
  })

  it('asks before the public address of card 1 changes what authentik knows, and saves on yes', async () => {
    fake.addressAsks = { count: 2, address: 'https://tasks.example.com/api/oidc/authentik/callback', hand: 0 }
    const shown = await page()
    const field = shown.querySelector(`input[aria-label="${oidcEn.oidc.admin.address}"], #sign-in input[type="text"], #sign-in input:not([type])`) as HTMLInputElement
    await type(field, 'https://new.example.com')
    await click(button(shown.querySelector('#sign-in') as HTMLElement, i18n.t('common.save')))
    await settle()
    expect(dialog().textContent).toContain(i18n.t('oidc.admin.addressChangeConfirm', { address: fake.addressAsks.address }))
    expect(dialog().textContent).not.toContain(oidcEn.oidc.admin.addressChangeHand_other.slice(0, 20))
    expect(calls('saveSettings').map((call) => (call.args[0] as { confirm_address: boolean }).confirm_address)).toEqual([false])
    expect(fake.settings.public_url).toBe('https://tasks.example.com')
    await click(button(dialog(), i18n.t('common.save')))
    await settle()
    expect(calls('saveSettings').map((call) => (call.args[0] as { confirm_address: boolean }).confirm_address)).toEqual([false, true])
    expect(fake.settings.public_url).toBe('https://new.example.com')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('the second factor requirement', () => {
  for (const language of ['de', 'en'] as const) {
    for (const own of [true, false]) {
      it(`names the provider switch that exempts a sign-in (${language}, ${own ? 'with' : 'without'} an own factor)`, async () => {
        viewer.two_factor = own
        const shown = await page(language)
        const hint = i18n.t(own ? 'server.twoFactorRequiredHint' : 'server.ownSecondFactorFirst', {
          trusts: i18n.t('oidc.admin.trustsSecondFactor'),
        })
        expect(shown.textContent).toContain(hint)
        // The words of the switch itself, between the quotes of the sentence: not a gap.
        const [open, close] = language === 'de' ? ['„', '“'] : ['“', '”']
        expect(shown.textContent).toContain(`${open}${i18n.t('oidc.admin.trustsSecondFactor')}${close}`)
      })
    }
  }
})
