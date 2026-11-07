/**
 * Colours and symbols of spaces and lists: the names the data model stores (`symbole.json`, column `lucide`), drawn
 * with lucide-react. An unknown name shows `list`.
 */
import { List, type LucideIcon } from 'lucide-react'

import { COLORS } from '../sync/types'
import { SYMBOLS, type SymbolEntry } from './symbols'

export { SYMBOL_GROUPS, SYMBOLS, type SymbolEntry, type SymbolGroup } from './symbols'

const BY_NAME = new Map(SYMBOLS.map((entry) => [entry.name, entry.icon]))

export function iconFor(name: string | null | undefined): LucideIcon {
  return BY_NAME.get(name ?? '') ?? List
}

/** Lower case without accents, so that "kuhl" finds "Kühlschrank" and "cafe" finds "Café". */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/**
 * The symbols a search finds: every word typed has to start a word of the symbol, among its name in the current
 * language (`title`) and its search words in German and English. Nothing typed finds all.
 */
export function findSymbols(query: string, title: (entry: SymbolEntry) => string): SymbolEntry[] {
  const parts = plain(query).split(/[\s-]+/).filter(Boolean)
  if (parts.length === 0) return SYMBOLS
  return SYMBOLS.filter((entry) => {
    const own = plain(`${title(entry)} ${entry.words}`).split(/[\s-]+/)
    return parts.every((part) => own.some((word) => word.startsWith(part)))
  })
}

/**
 * nextasks' own list colours (docs "Aussehen", principle 2): a little calmer than system colours, each dark enough to
 * carry the white symbol of a plaque. The names are the data model's.
 */
const HEX: Record<string, string> = {
  red: '#d9534f',
  orange: '#dd7a2e',
  yellow: '#d39b12',
  green: '#4f9e3f',
  teal: '#22a08a',
  blue: '#3a84d0',
  indigo: '#5b68cc',
  purple: '#8a59c0',
  pink: '#d65a7c',
  brown: '#9a7550',
  gray: '#7a8890',
}

export const COLOR_NAMES = COLORS

export function colorOf(name: string | null | undefined): string {
  return HEX[name ?? ''] ?? HEX.blue
}
