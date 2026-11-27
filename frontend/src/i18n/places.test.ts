/**
 * Every text that points somewhere names the place as the settings call it now (plan "Einstellungen", E39): the areas
 * and cards of the shared kit and modules, never the old names (API token, the tab "Server", "Einstellungen, Profil").
 * Written as the plan writes it (E46): "›" between the steps, starting with the group ("Mein Konto › Verbindungen ›
 * API-Schlüssel", "Server › Verbindungen › Schnittstellen"); "Einstellungen ›" only in front of a group.
 */
import { describe, expect, it } from 'vitest'

import de from './de.json'
import en from './en.json'
import whatsNewDe from '../../../backend/app/whatsnew/de.json'
import whatsNewEn from '../../../backend/app/whatsnew/en.json'

const all = (tree: unknown): string => JSON.stringify(tree)

const AREAS = {
  de: ['Profil', 'Sicherheit', 'Darstellung', 'Benachrichtigungen', 'Verbindungen', 'Allgemein', 'Anmeldung', 'Mail', 'Speicher und Sicherungen', 'Konten', 'Log'],
  en: ['Profile', 'Security', 'Appearance', 'Notifications', 'Connections', 'General', 'Sign-in', 'Mail', 'Storage and backups', 'Accounts', 'Log'],
}
const GROUPS = { de: ['Mein Konto', 'Server'], en: ['My account', 'Server'] }

/** The places in a text: every run of steps joined by "›" (or by an arrow, which the rule forbids). */
function places(text: string): string[] {
  return text.match(/[\p{L}][\p{L}\- ]*(?: (?:›|→|->) [\p{L}][\p{L}\-() ]*)+/gu) ?? []
}

/** What is wrong with the places of a text, for one language ([] when they follow E46). */
export function wrongPlaces(text: string, lang: 'de' | 'en'): string[] {
  const settings = lang === 'de' ? 'Einstellungen' : 'Settings'
  const wrong: string[] = []
  for (const found of places(text)) {
    if (/→|->/.test(found)) {
      wrong.push(`${found}: an arrow`)
      continue
    }
    const steps = found.split(' › ').map((step) => step.trim())
    // The words in front of the place are part of the sentence ("unter Mein Konto"): the step is the last ones.
    const first = steps[0]
    const head = [settings, ...GROUPS[lang], ...AREAS[lang]].find((name) => first === name || first.endsWith(` ${name}`))
    if (!head) continue // not a place of the settings (Teilen › Zum Home-Bildschirm, Aufgabe › Verlauf)
    if (head === settings) {
      if (!GROUPS[lang].includes(steps[1])) wrong.push(`${found}: "${settings} ›" not in front of a group`)
    } else if (!GROUPS[lang].includes(head)) wrong.push(`${found}: starts with "${head}", not with the group`)
  }
  // Commas as separators of settings places ("Mein Konto, Sicherheit", "Allgemein, Karte Schnittstellen").
  for (const group of GROUPS[lang]) {
    for (const area of AREAS[lang]) if (text.includes(`${group}, ${area}`)) wrong.push(`${group}, ${area}: a comma`)
  }
  if (/(Allgemein|General), (Karte|card) /.test(text)) wrong.push('a card named after a comma')
  return wrong
}

describe('the places the texts point to', () => {
  it('are the ones of the settings now', () => {
    expect(de.errors.public_url_missing).toContain('Server › Anmeldung')
    expect(en.errors.public_url_missing).toContain('Server › Sign-in')
    // E67: the card "Schnittstellen" stands under Server › Verbindungen, no longer under Allgemein.
    expect(de.errors.api_off).toContain('Server › Verbindungen › Schnittstellen')
    expect(en.errors.api_off).toContain('Server › Connections › Interfaces')
    const shipped = [de, en, whatsNewDe, whatsNewEn].map(all).join('\n')
    expect(shipped).not.toMatch(/Allgemein › (Schnittstellen|Andere nex-Apps)|General › (Interfaces|Other nex apps)/)
    expect(all(whatsNewDe['0.9.0'])).toContain('Server › Verbindungen › Andere nex-Apps')
    expect(all(whatsNewEn['0.9.0'])).toContain('Server › Connections › Other nex apps')
    expect(de.errors.token_reads_only).toContain('Mein Konto › Verbindungen › API-Schlüssel')
    expect(en.errors.token_reads_only).toContain('My account › Connections › API keys')
    expect(de.someday.hidden).toContain('Mein Konto › Darstellung › Seitenleiste')
    expect(en.someday.hidden).toContain('My account › Appearance › Sidebar')
  })

  it('never name the places of before', () => {
    const shipped = [de, en, whatsNewDe, whatsNewEn].map(all).join('\n')
    expect(shipped.match(/API-Token|API tokens?\b|Einstellungen, Server|Settings, Server|Einstellungen, Profil|Settings, Profile|Mein Konto, |My account, |„Seitenleiste“|“Sidebar”/g)).toBeNull()
  })

  it('are written group › area › card, with no arrow or comma between the steps (E46)', () => {
    expect([all(de), all(whatsNewDe)].flatMap((text) => wrongPlaces(text, 'de'))).toEqual([])
    expect([all(en), all(whatsNewEn)].flatMap((text) => wrongPlaces(text, 'en'))).toEqual([])
  })

  it('sees a place that breaks the rule', () => {
    expect(wrongPlaces('Leg unter Verbindungen › API-Schlüssel einen an.', 'de')).toHaveLength(1)
    expect(wrongPlaces('Unter Einstellungen › Profil › Sprache.', 'de')).toHaveLength(1)
    expect(wrongPlaces('Under Settings → Server → Accounts.', 'en')).toHaveLength(1)
    expect(wrongPlaces('Richte ihn unter Mein Konto, Sicherheit ein.', 'de')).toHaveLength(1)
    expect(wrongPlaces('Unter Mein Konto › Verbindungen › API-Schlüssel und Server › Anmeldung.', 'de')).toEqual([])
    expect(wrongPlaces('Unter Einstellungen › Mein Konto › Benachrichtigungen.', 'de')).toEqual([])
    expect(wrongPlaces('Auf iPhone und iPad: Teilen › Zum Home-Bildschirm.', 'de')).toEqual([])
  })
})

/** The text of an entry without its signposts ("where", "link"): what the released version said, never changed. */
function textOf(entry: unknown): string {
  const strip = (part: unknown): unknown =>
    Array.isArray(part) ? part.map(strip)
      : part && typeof part === 'object' ? Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'where' && key !== 'link').map(([key, value]) => [key, strip(value)]))
        : part
  // FNV-1a over the characters, twice with different seeds: a fingerprint, no secret.
  const text = JSON.stringify(strip(entry))
  const fnv = (seed: number): string => {
    let hash = seed >>> 0
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
    return hash.toString(16).padStart(8, '0')
  }
  return fnv(0x811c9dc5) + fnv(0x01234567)
}

/** The texts of the released versions as they shipped (taken from the branch konten, before the settings' rebuild). */
const SHIPPED: Record<'de' | 'en', Record<string, string>> = {
  de: { '0.8.0': '13e8e88e21a57760', '0.7.0': '0b168ffb9de1094d', '0.6.0': 'caa8654590abf11b', '0.5.1': '887f7f0ae14eb480', '0.5.0': '3e2973220b636114', '0.4.3': 'b79b53a686c288d8', '0.4.2': 'd90e004a558b0898', '0.4.1': 'f2a2293713dcc29d', '0.4.0': '12c938f6fb91c9b8', '0.3.2': '65cb0290a923575e', '0.3.1': 'd94a2895fa11162f', '0.3.0': '4306c75928e081fb', '0.2.1': '649eefbc44892016', '0.2.0': '1eb5d26a9b315730', '0.1.0': 'c3aa969955275377' },
  en: { '0.8.0': '723405afcf8e1c01', '0.7.0': 'a0ce83512ef88043', '0.6.0': '4c3e4394d68eb9ba', '0.5.1': 'eeb67f0f090f8ddd', '0.5.0': '4f66a0b969c72df3', '0.4.3': 'b070e8953a096d87', '0.4.2': '1f74470b4a89aa21', '0.4.1': 'd6cb5f0b463ee751', '0.4.0': '1e5e5616b774e8a4', '0.3.2': 'ef51670e821ad4cc', '0.3.1': '29d6b37b36a4d451', '0.3.0': '53d11e89a7d82b9f', '0.2.1': '56b215b8010d100e', '0.2.0': '92a8490aadf81ee8', '0.1.0': '845f7170b3d3acde' },
}

describe('what is new in a released version', () => {
  // E49: only the signposts ("where") point to the place of today; the text says what it said then.
  it('keeps its text as it shipped, only the signposts follow the settings', () => {
    for (const [lang, entries] of [['de', whatsNewDe], ['en', whatsNewEn]] as const) {
      const now = Object.fromEntries(Object.keys(SHIPPED[lang]).map((version) => [version, textOf((entries as Record<string, unknown>)[version])]))
      expect(now).toEqual(SHIPPED[lang])
    }
  })
})
