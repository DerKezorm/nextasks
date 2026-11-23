// The large view of a picture (`PictureViewer`, `.nt-viewer`) as nexnotes': it covers the app in light and dark, and its
// bar's name and buttons stand at 4.5:1 or more on the bar's own ground, the buttons' edge at 3:1 (WCAG AA). Read from
// the theme colours in `styles/index.css`, as the browser gets them.
import { describe, expect, it } from 'vitest'

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files
const css = files.readFileSync('src/styles/index.css', 'utf-8').replace(/\r\n/g, '\n')

/** The colours a theme block sets (`@theme` dark, `:root[data-theme='light']` light). */
function themeColors(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1], match[2]]))
}

/** The body of a rule in the components layer. */
function rule(selector: string): string {
  const at = css.indexOf(`  ${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

function token(body: string, property: string): string {
  return new RegExp(`(?:^|\\s)${property}: var\\((--[\\w-]+)\\)`).exec(body)?.[1] ?? ''
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('the large view of a picture', () => {
  it('covers the app and its bar is readable in light and dark', () => {
    const ground = token(rule('.nt-viewer'), 'background-color')
    const barGround = token(rule('.nt-viewer-bar'), 'background-color')
    const text = token(rule('.nt-viewer-bar'), 'color')
    const ghost = /\.nt-btn-ghost \{\s*@apply ([^;]+);/.exec(css)![1]
    const ghostText = `--color-${/(?:^| )text-([\w-]+)/.exec(ghost)![1]}`
    const ghostEdge = `--color-${/border-([\w-]+)/.exec(ghost)![1]}`
    for (const selector of ['@theme', ":root[data-theme='light']"]) {
      const colors = themeColors(selector)
      // Every colour a plain hex, nothing half-transparent: fully covering.
      for (const name of [ground, barGround, text, ghostText, ghostEdge]) expect(colors[name], `${selector} ${name}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrast(colors[text], colors[barGround]), `${selector} name`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors[ghostText], colors[barGround]), `${selector} buttons`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors[ghostEdge], colors[barGround]), `${selector} edge of the buttons`).toBeGreaterThanOrEqual(3)
    }
  })
})
