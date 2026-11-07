/**
 * The symbols: every stored name of the first list still draws its symbol, and the search finds by name and by the
 * search words of both languages, without accents.
 */
import { List } from 'lucide-react'

import { findSymbols, iconFor, plain, SYMBOL_GROUPS, SYMBOLS } from './look'

const SINCE_FIRST = (
  'list cart house briefcase gift heart star book school sport car bike plane food coffee health doctor pet plant ' +
  'tools paint music game film camera calendar clock bell flag bookmark inbox folder document money card people ' +
  'person computer phone globe sun moon party trophy idea lock'
).split(' ')

const names = (query: string, title: (name: string) => string = () => '') =>
  findSymbols(query, (entry) => title(entry.name)).map((entry) => entry.name)

describe('the symbols', () => {
  it('keep every name lists and spaces were saved with', () => {
    expect(SINCE_FIRST.filter((name) => name !== 'list' && iconFor(name) === List)).toEqual([])
    const known = new Set(SYMBOLS.map((entry) => entry.name))
    expect(SINCE_FIRST.filter((name) => !known.has(name))).toEqual([])
  })

  it('are many, each name once, each in a known group', () => {
    expect(SYMBOLS.length).toBeGreaterThan(200)
    expect(new Set(SYMBOLS.map((entry) => entry.name)).size).toBe(SYMBOLS.length)
    expect(SYMBOLS.filter((entry) => !SYMBOL_GROUPS.includes(entry.group))).toEqual([])
  })

  it('show the plain list for a name nobody knows', () => {
    expect(iconFor('no-such-symbol')).toBe(List)
    expect(iconFor(null)).toBe(List)
  })

  it('are found by German and English words, from the start of a word', () => {
    expect(names('hund')).toContain('dog')
    expect(names('dog')).toContain('dog')
    expect(names('einkauf')).toEqual(expect.arrayContaining(['cart', 'basket', 'bag']))
    expect(names('og')).not.toContain('dog')
  })

  it('ignore accents and ß', () => {
    expect(names('kuhl')).toContain('fridge')
    expect(names('strasse')).toContain('tram')
    expect(plain('Kühlschrank Café Straße')).toBe('kuhlschrank cafe strasse')
  })

  it('need every word typed', () => {
    expect(names('wetter regen')).toEqual(['rain'])
  })

  it('also find by the name shown in the current language', () => {
    expect(names('zzspecial', (name) => (name === 'star' ? 'Zzspecial' : ''))).toEqual(['star'])
  })

  it('find all when nothing is typed', () => {
    expect(names('  ')).toHaveLength(SYMBOLS.length)
  })
})
