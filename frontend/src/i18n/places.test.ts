/**
 * Every text that points somewhere names the place as the settings call it now (plan "Einstellungen", E39): the areas
 * and cards of the shared kit and modules, never the old names (API token, the tab "Server", "Einstellungen, Profil").
 * Written as the plan writes it (E46): "›" between the steps, starting with the group ("Mein Konto › Verbindungen ›
 * API-Schlüssel", "Server › Allgemein › Schnittstellen"); "Einstellungen ›" only in front of a group.
 */
import { describe, expect, it } from 'vitest'

import de from './de.json'
import en from './en.json'
import whatsNewDe from './whatsnew/de.json'
import whatsNewEn from './whatsnew/en.json'

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
    expect(de.errors.api_off).toContain('Server › Allgemein › Schnittstellen')
    expect(en.errors.api_off).toContain('Server › General › Interfaces')
    expect(de.errors.token_reads_only).toContain('Mein Konto › Verbindungen › API-Schlüssel')
    expect(en.errors.token_reads_only).toContain('My account › Connections › API keys')
    expect(de.someday.hidden).toContain('Mein Konto › Darstellung › Seitenleiste')
    expect(en.someday.hidden).toContain('My account › Appearance › Sidebar')
    expect(de.server.languageAdded).toContain('Mein Konto › Profil › Sprache')
    expect(en.server.languageAdded).toContain('My account › Profile › Language')
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
