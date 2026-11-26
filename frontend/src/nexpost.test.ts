// Vorlage nexpost 1.1.0
/**
 * Every text of the post module is in the app, in German and English, through the app's own i18n, and the mail
 * server card shows the module's fields in the module's order. Copied once by the module's `tools/sync.py` to
 * `frontend/src/nexpost.test.ts`; then the app's file. Fill in the places marked APP.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { smallWorld } from './test/fakeServer'
import { choose, mount, unmount } from './test/harness'

import { MAIL_FIELDS, mailErrorKey, postVariables, warnUnencrypted } from './vendor/nexpost/post'
import de from './vendor/nexpost/post.de.json'
import en from './vendor/nexpost/post.en.json'
// APP: the app's i18n instance after its set-up (with the module's files merged into the resources and
// interpolation.defaultVariables: postVariables(APP_NAME)).
import i18n from './i18n'

// APP: the app's name as its container is called.
const APP_NAME = 'nextasks'
// APP: the fields the app's mail server card shows, top to bottom (MAIL_FIELDS): nextasks' card lays them out by
// MAIL_FIELDS itself (pages/settings/ServerCards.tsx, MailCard).
const APP_FIELDS: readonly string[] = MAIL_FIELDS

type Tree = { [key: string]: string | Tree }

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [[key, value] as [string, string]] : leaves(value, key)
  })
}

const values = { email: 'kim@example.com', when: 'today', error: 'mail_unreachable', count: 3 }
const fill: Record<string, string | number> = { ...postVariables(APP_NAME), ...values }

describe('the post texts', () => {
  for (const [language, tree] of [['de', de], ['en', en]] as const) {
    it(`are all in the app in ${language}, word for word`, async () => {
      await i18n.changeLanguage(language)
      for (const [key, text] of leaves(tree as Tree)) {
        const expected = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(fill[name] ?? ''))
        expect(i18n.t(key, values), key).toBe(expected)
      }
    })
  }
})

describe('the mail server card', () => {
  it('shows the fields of the module in its order', () => {
    expect(APP_FIELDS).toEqual(MAIL_FIELDS)
  })

  it('warns without encryption and names every error', () => {
    expect(warnUnencrypted({ security: 'none', user: 'robot', password: '', passwordSet: false })).toBe(true)
    expect(mailErrorKey('mail_off')).toBe('mail.error.mail_off')
    expect(mailErrorKey('something')).toBe('mail.error.unknown')
  })
})

describe("nextasks' mail server card", () => {
  afterEach(async () => {
    await unmount()
  })

  it('shows the fields in the order of MAIL_FIELDS, the port follows the encryption, a warning without it', async () => {
    const { server } = smallWorld()
    server.settings = { ...server.settings, smtp_host: 'mail.example.com', smtp_port: 587, smtp_security: 'starttls', smtp_user: 'robot', smtp_password_set: true, smtp_from: 'tasks@example.com' }
    const page = await mount(server, '/settings/mail')
    const form = page.querySelector('[data-testid="mail-form"]')!
    // The card of the module post (1.1.0): every field named by its label.
    const labels = [...form.querySelectorAll('label')].map((label) => label.textContent)
    const words: Record<(typeof MAIL_FIELDS)[number], string> = { server: 'mail.server', port: 'mail.port', security: 'mail.security', user: 'mail.user', password: 'mail.password', sender: 'mail.sender', senderName: 'mail.senderName' }
    expect(labels).toEqual(MAIL_FIELDS.map((field) => i18n.t(words[field])))
    expect(form.querySelector('[data-testid="mail-warning"]')).toBeNull()
    await choose(form.querySelector('select'), 'tls')
    expect((form.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('465')
    await choose(form.querySelector('select'), 'none')
    expect((form.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('25')
    expect(form.querySelector('[data-testid="mail-warning"]')?.textContent).toBe(i18n.t('mail.warningUnencrypted'))
  })
})
