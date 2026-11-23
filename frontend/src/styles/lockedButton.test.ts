// A locked button stays grey in every state, in light and dark: its hover never paints it. `.nt-btn:disabled` and
// `.nt-btn-accent:hover` weigh the same and the variant comes later, so a bare `hover:` in a variant would win over the
// locked look (a locked "Create filter" turned petrol under the pointer). Every hover of a button class, and every
// hover added to such a button in the components, is therefore `not-disabled:hover:`. Read from the sources.
import { describe, expect, it } from 'vitest'

type Files = {
  readFileSync: (file: string, encoding: string) => string
  readdirSync: (dir: string, options: { recursive: true }) => string[]
}
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files
const css = files.readFileSync('src/styles/index.css', 'utf-8').replace(/\r\n/g, '\n')

/** The utilities a rule of the components layer applies. */
function applied(selector: string): string[] {
  const match = new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{\\s*@apply ([^;]+);`).exec(css)
  expect(match, selector).not.toBeNull()
  return match![1].split(/\s+/)
}

/** The utilities that act on hover but not only while the button is free. */
const bareHover = (classes: string[]) => classes.filter((name) => /(^|:)hover:/.test(name) && !name.startsWith('not-disabled:hover:'))

const BUTTONS = ['.nt-btn', '.nt-btn-accent', '.nt-btn-ghost', '.nt-btn-danger', '.nt-btn-quiet', '.nt-icon-btn', '.nt-menu-item', '.nt-menu-danger', '.nt-toggle']

describe('a locked button', () => {
  it('has a grey look of its own', () => {
    expect(applied('.nt-btn')).toEqual(expect.arrayContaining(['disabled:bg-ink-800', 'disabled:text-mist-600', 'disabled:cursor-not-allowed']))
  })

  it('is not painted by the hover of any button class', () => {
    for (const selector of BUTTONS) expect(bareHover(applied(selector)), selector).toEqual([])
  })

  it('is not painted by a hover a component adds to a button', () => {
    const sources = files
      .readdirSync('src', { recursive: true })
      .map((name) => name.replace(/\\/g, '/'))
      .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
    const found: string[] = []
    for (const name of sources) {
      const text = files.readFileSync(`src/${name}`, 'utf-8')
      for (const literal of text.match(/(['"`])[^'"`\n]*\bnt-(?:btn|icon-btn)\b[^'"`\n]*\1/g) ?? []) {
        for (const utility of bareHover(literal.slice(1, -1).split(/\s+/))) found.push(`${name}: ${utility}`)
      }
    }
    expect(found).toEqual([])
  })
})
