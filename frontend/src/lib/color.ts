/**
 * An own colour (`#rrggbb`, contract 0.8) on both looks of the page, as nexnotes' `lib/color.ts`. The fixed colours
 * are chosen for them; an own one can be anything, so it is drawn so that it reads on light and on dark grounds alike.
 */

export const HEX = /^#[0-9a-f]{6}$/

/** `#RRGGBB` or `#rrggbb` (with or without the #) as stored, else null. Short forms and names are no colours here. */
export function hexOf(text: string): string | null {
  const value = text.trim().toLowerCase()
  const full = value.startsWith('#') ? value : `#${value}`
  return HEX.test(full) ? full : null
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]
}

function toHex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')
}

/** Relative luminance after WCAG 2. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** The grounds a mark stands on: page, sidebar and dialogs, light and dark (`styles/index.css`). */
export const BACKGROUNDS = ['#ffffff', '#f4f6f7', '#eef2f3', '#0f1417', '#131a1f', '#172026']

function mix(hex: string, toward: string, share: number): string {
  const [a, b] = [channels(hex), channels(toward)]
  return toHex(a.map((value, index) => value + (b[index] - value) * share))
}

/**
 * The own colour as a symbol shows it: itself when it stands out from every ground by at least 3:1 (WCAG for
 * graphics), else lightened or darkened just as far as needed. The hue stays.
 */
export function readableColor(hex: string): string {
  const reads = (value: string) => BACKGROUNDS.every((background) => contrast(value, background) >= 3)
  if (reads(hex)) return hex
  // Too dark for the dark grounds: toward white until it stands out from all of them; too light for the light ones:
  // toward black. Each grows steadily with the share, so halving finds it.
  const dark = luminance(hex) < 0.2
  const toward = dark ? '#ffffff' : '#000000'
  const side = BACKGROUNDS.filter((background) => (luminance(background) < 0.5) === dark)
  const enough = (value: string) => side.every((background) => contrast(value, background) >= 3)
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2
    if (enough(mix(hex, toward, middle))) high = middle
    else low = middle
  }
  return mix(hex, toward, high)
}

/** Black or white, whichever reads better on a fill of `hex` (the check mark on a chosen colour). */
export function inkOn(hex: string): '#000000' | '#ffffff' {
  return contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff'
}
