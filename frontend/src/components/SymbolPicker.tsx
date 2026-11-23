/**
 * The symbol and the colour of a list, a space or an own filter, as nexnotes' `SymbolPicker` and `ColorField`.
 *
 * Symbols: a search over the names in German and English, otherwise all in their groups. One stop in the tab order:
 * the arrow keys move inside the grid (up and down by a row), Home and End go to the first and last, Enter in the
 * search takes the only match. The chosen one stays marked, also when the search hides it.
 *
 * Colours: the fixed ones of the data model, the own ones used last on this device and any other as `#rrggbb`.
 */
import { Check, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { hexOf, inkOn } from '../lib/color'
import { useDevicePref } from '../lib/devicePref'
import { COLOR_NAMES, fillOf, findSymbols, SYMBOL_GROUPS, type SymbolEntry } from '../lib/look'

export function SymbolPicker({ value, onChange, color }: { value: string; onChange: (name: string) => void; color?: string }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  const title = (entry: SymbolEntry) => t(`look.icons.${entry.name}`)
  const found = useMemo(() => findSymbols(query, (entry) => t(`look.icons.${entry.name}`)), [query, t])
  const searching = query.trim() !== ''
  // The one stop in the tab order: the chosen symbol if it shows, else the first.
  const stop = found.some((entry) => entry.name === value) ? value : found[0]?.name

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const here = buttons[at].getBoundingClientRect()
    // Up and down: the nearest symbol in the row above or below, by position (the groups' rows differ in length).
    const vertical = (down: boolean) => {
      const rows = buttons.filter((button) => {
        const box = button.getBoundingClientRect()
        return down ? box.top > here.top + 1 : box.top < here.top - 1
      })
      if (rows.length === 0) return at
      const row = down ? Math.min(...rows.map((b) => b.getBoundingClientRect().top)) : Math.max(...rows.map((b) => b.getBoundingClientRect().top))
      const inRow = rows.filter((button) => Math.abs(button.getBoundingClientRect().top - row) < 1)
      const best = inRow.reduce((a, b) => (Math.abs(b.getBoundingClientRect().left - here.left) < Math.abs(a.getBoundingClientRect().left - here.left) ? b : a))
      return buttons.indexOf(best)
    }
    const next =
      event.key === 'ArrowRight' ? Math.min(at + 1, buttons.length - 1)
      : event.key === 'ArrowLeft' ? Math.max(at - 1, 0)
      : event.key === 'ArrowDown' ? vertical(true)
      : event.key === 'ArrowUp' ? vertical(false)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : -1
    if (next < 0) return
    event.preventDefault()
    buttons[next].focus()
  }

  const button = (entry: SymbolEntry) => {
    const chosen = entry.name === value
    return (
      <button
        key={entry.name}
        type="button"
        role="radio"
        aria-checked={chosen}
        aria-label={title(entry)}
        title={title(entry)}
        tabIndex={entry.name === stop ? 0 : -1}
        onClick={() => onChange(entry.name)}
        data-symbol={entry.name}
        className={'grid h-9 w-full place-items-center rounded-lg outline-offset-2 ' + (chosen ? 'bg-accent-wash ring-2 ring-accent-500' : 'text-mist-300 hover:bg-ink-800')}
        style={chosen && color ? { color } : undefined}
      >
        <entry.icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
    )
  }
  const cells = 'grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5'

  return (
    <fieldset>
      <legend className="nt-legend">{t('look.icon')}</legend>
      <label className="relative mb-2 block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-mist-500" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter takes the only match instead of sending the form.
            if (event.key === 'Enter') {
              event.preventDefault()
              if (found.length === 1) onChange(found[0].name)
            }
          }}
          placeholder={t('look.iconSearch')}
          aria-label={t('look.iconSearch')}
          className="nt-field pl-8"
          data-testid="symbol-search"
        />
      </label>
      <div ref={grid} className="nt-scroll h-60 overflow-y-auto p-1.5" role="radiogroup" aria-label={t('look.icon')} onKeyDown={move} data-testid="symbol-grid">
        {searching ? (
          found.length > 0 ? (
            <div className={cells}>{found.map(button)}</div>
          ) : (
            <p className="py-3 text-sm text-mist-500">{t('look.iconNone')}</p>
          )
        ) : (
          SYMBOL_GROUPS.map((group) => (
            <div key={group} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t(`look.iconGroups.${group}`)}</p>
              <div className={cells}>{found.filter((entry) => entry.group === group).map(button)}</div>
            </div>
          ))
        )}
      </div>
    </fieldset>
  )
}

/** How many own colours the device keeps at hand, as in nexnotes. */
export const RECENT_COLORS = 6

function parseRecent(raw: string | null): string[] {
  try {
    const list = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list.map((item) => hexOf(String(item))).filter((item): item is string => item !== null).slice(0, RECENT_COLORS) : []
  } catch {
    return []
  }
}

function Swatch({ color, label, chosen, onChoose }: { color: string; label: string; chosen: boolean; onChoose: () => void }) {
  const fill = fillOf(color)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      aria-label={label}
      title={label}
      onClick={onChoose}
      className={'flex h-8 items-center justify-center rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent-500 ' + (chosen ? 'ring-2 ring-mist-100 ring-offset-2 ring-offset-ink-850' : 'border border-ink-600')}
      style={{ background: fill }}
      data-color={color}
    >
      {chosen && <Check aria-hidden className="h-4 w-4" strokeWidth={3} style={{ color: inkOn(fill) }} data-testid="color-chosen" />}
    </button>
  )
}

/**
 * The fixed colours, the own colours used last on this device, and any other through the system's colour picker or
 * as `#rrggbb`, as nexnotes' `ColorField` (contract 0.8). The chosen one carries a check mark in black or white,
 * whichever reads on it.
 */
export function ColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  const [recentRaw, setRecent] = useDevicePref('colors.own', (raw) => raw)
  const recent = parseRecent(recentRaw)
  const own = value.startsWith('#') ? hexOf(value) : null
  const [draft, setDraft] = useState(own ?? '')
  const [wrong, setWrong] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(own ?? ''), [own])

  /** An own colour is chosen: it goes first in the row of recent ones. */
  const takeOwn = (hex: string) => {
    setWrong(false)
    setRecent(JSON.stringify([hex, ...recent.filter((item) => item !== hex)].slice(0, RECENT_COLORS)))
    onChange(hex)
  }

  // The system's picker reports every move while it is open ("input") and the result when it closes ("change"): the
  // field follows the moves, the choice is the result.
  useEffect(() => {
    const input = picker.current
    if (!input) return
    const done = () => {
      const hex = hexOf(input.value)
      if (hex) takeOwn(hex)
    }
    input.addEventListener('change', done)
    return () => input.removeEventListener('change', done)
  })

  const typed = () => {
    if (!draft.trim()) return
    const hex = hexOf(draft)
    if (hex) takeOwn(hex)
    else setWrong(true)
  }

  return (
    <fieldset>
      <legend className="nt-legend">{t('look.color')}</legend>
      <div className="grid grid-cols-6 gap-2" role="radiogroup" aria-label={t('look.color')}>
        {COLOR_NAMES.map((name) => (
          <Swatch key={name} color={name} label={t(`look.colors.${name}`)} chosen={value === name} onChoose={() => onChange(name)} />
        ))}
        {recent.map((hex) => (
          <Swatch key={hex} color={hex} label={t('look.ownColor', { hex })} chosen={own === hex} onChoose={() => takeOwn(hex)} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-mist-300">
          <input
            ref={picker}
            type="color"
            value={own ?? fillOf(value)}
            aria-label={t('look.pickColor')}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-10 cursor-pointer rounded-lg border border-ink-600 bg-transparent p-0.5"
            data-testid="color-picker"
          />
          {t('look.custom')}
        </label>
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setWrong(false)
          }}
          onBlur={typed}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            typed()
          }}
          placeholder="#rrggbb"
          aria-label={t('look.hex')}
          aria-invalid={wrong || undefined}
          aria-describedby={wrong ? 'color-hex-wrong' : undefined}
          maxLength={7}
          spellCheck={false}
          className="nt-field w-28 font-mono"
          data-testid="color-hex"
        />
      </div>
      {wrong && (
        <p id="color-hex-wrong" role="alert" className="mt-1 text-xs text-bad-500">
          {t('look.hexWrong')}
        </p>
      )}
    </fieldset>
  )
}
