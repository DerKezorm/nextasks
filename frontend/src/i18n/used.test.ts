/**
 * Every shipped text is asked for somewhere, numbers count right, and English is English (Prüfgang H1, H3, H5, H10).
 * "Download template" (Settings, General) hands every key to translators: a text no page shows is work for nothing,
 * and a sentence of another app (a vault, a canvas, notes) told them nextasks had it.
 *
 * A key counts as asked for when the code names it, or names its start in a built key (`notices.${kind}`,
 * `auth.invite.intoSpace${by}`). The error texts are checked against the server's codes in
 * `backend/tests/test_texts.py`.
 */

import i18n from 'i18next'

import de from './de.json'
import en from './en.json'

type Files = {
  readFileSync: (file: string, encoding: string) => string
  readdirSync: (folder: string, options: { recursive: true }) => string[]
}
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

function flat(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flat(value as Record<string, unknown>, `${prefix}${key}.`) : [prefix + key],
  )
}

const source = files
  .readdirSync('src', { recursive: true })
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.') && !name.startsWith('i18n/'))
  // The shared sign-in module brings its own texts (`oidc.…`, checked by nexoidc.wording.test.ts); its comments name
  // the server's code lists, no keys of nextasks.
  .filter((name) => !name.startsWith('vendor/'))
  .map((name) => files.readFileSync(`src/${name}`, 'utf-8'))
  .join('\n')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function askedFor(key: string): boolean {
  const base = key.replace(/_(one|other|zero)$/, '')
  if (source.includes(base)) return true
  // A key with a built end: `auth.invite.intoSpace${by}` asks for intoSpace and intoSpaceBy.
  const stem = base.replace(/[A-Z][a-z]*$/, '')
  if (stem !== base && new RegExp(`['\`]${escape(stem)}\\$\\{`).test(source)) return true
  const parts = base.split('.')
  for (let end = parts.length - 1; end > 0; end--) {
    const start = parts.slice(0, end).join('.') + '.'
    if (new RegExp(`['\`]${escape(start)}\\$\\{`).test(source)) return true
  }
  return false
}

const text = (tree: unknown, key: string) => String(key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree))

describe('the shipped texts', () => {
  it('are all asked for by some page', () => {
    const unused = flat(de).filter((key) => !key.startsWith('errors.') && !askedFor(key))
    expect(unused).toEqual([])
  })

  it('have every key a page asks for, in both languages', () => {
    // A key named whole in the code: t('nav.today'), i18nKey="…", or a constant handed to t() later (label:
    // 'nav.lists'). Built keys (`notices.${kind}`) are left to the check above. A deleted key shows its bare name
    // where its text belongs.
    const spaces = new Set(Object.keys(de))
    const keys = new Set(flat(de))
    const english = new Set(flat(en))
    const has = (set: Set<string>, key: string) => set.has(key) || set.has(`${key}_one`) || set.has(`${key}_other`)
    const asked = [...source.matchAll(/['"`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"`]/g)]
      .map((m) => m[1])
      .filter((key) => spaces.has(key.split('.')[0]) && !/\.(tsx?|json|svg|png|css|js)$/.test(key))
    expect(asked.length).toBeGreaterThan(500)
    expect([...new Set(asked.filter((key) => !has(keys, key) || !has(english, key)))]).toEqual([])
  })

  it('count none, one and many in both languages', async () => {
    await i18n.init({ resources: { de: { translation: de }, en: { translation: en } }, lng: 'de', interpolation: { escapeValue: false } })
    const backup = (language: string, tasks: number, count: number) => {
      const t = i18n.getFixedT(language)
      return t('server.backupContent', { tasks: t('server.backupTasks', { count: tasks }), files: t('server.backupFiles', { count }) })
    }
    expect(backup('de', 1, 1)).toBe('eine Aufgabe, eine Datei')
    expect(backup('de', 19, 0)).toBe('19 Aufgaben, keine Datei')
    expect(backup('en', 1, 1)).toBe('one task, one file')
    expect(backup('en', 2, 3)).toBe('2 tasks, 3 files')
    const german = i18n.getFixedT('de')
    const english = i18n.getFixedT('en')
    expect(german('list.open', { count: 1 })).toBe('eine offene Aufgabe')
    expect(german('list.open', { count: 3 })).toBe('3 offene Aufgaben')
    expect(english('trash.days', { count: 1 })).toBe('one day left')
    expect(german('sync.offline', { count: 2 })).toBe('Keine Verbindung. 2 Änderungen warten.')
    expect(english('repeat.every.week', { count: 2 })).toBe('Every 2 weeks')
    expect(german('repeat.every.week', { count: 1 })).toBe('Jede Woche')
    // No count that reads "1 Aufgaben": every text with {{count}} and a noun after it has its _one form.
    const counted = flat(de).filter((key) => !/_(one|other|zero)$/.test(key) && /\{\{count\}\} \p{Lu}/u.test(text(de, key)))
    expect(counted).toEqual([])
  })

  it('speak English, not German word for word', () => {
    // "Angeben" is enter, "anlegen" is create, "enthalten" is contain, "abgelaufen" is expired (WORTLAUTE.md).
    const stiff = flat(en).filter((key) =>
      /\bGive (a|the|your)\b|\bMake (a|one|them|new)\b|\bmakes? (a|an|new|its|their)\b|\bholds?\b|\b(runs?|ran) out\b|\bWhole:|\bhangs on\b|\bthe own\b|\bTake (the )?second factor\b/i.test(text(en, key)),
    )
    expect(stiff).toEqual([])
  })

  it('speak of nextasks only', () => {
    const raw = [de, en].map((tree) => JSON.stringify(tree)).join('\n')
    expect(raw.match(/notes\.example\.com|wie in nexlore|as in nexlore|nextrmnl|Tresor|Leinwand|vault|KI in Notizen|diese Notiz|keine Notiz/g)).toBeNull()
  })
})
