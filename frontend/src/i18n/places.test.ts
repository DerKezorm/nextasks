/**
 * Every text that points somewhere names the place as the settings call it now (plan "Einstellungen", E39): the areas
 * and cards of the shared kit and modules, never the old names (API token, the tab "Server", "Einstellungen, Profil").
 */
import { describe, expect, it } from 'vitest'

import de from './de.json'
import en from './en.json'
import whatsNewDe from './whatsnew/de.json'
import whatsNewEn from './whatsnew/en.json'

const all = (tree: unknown): string => JSON.stringify(tree)

describe('the places the texts point to', () => {
  it('are the ones of the settings now', () => {
    expect(de.errors.public_url_missing).toContain('Server › Anmeldung')
    expect(en.errors.public_url_missing).toContain('Server › Sign-in')
    expect(de.errors.api_off).toContain('Server › Allgemein › Schnittstellen')
    expect(en.errors.api_off).toContain('Server › General › Interfaces')
    expect(de.errors.token_reads_only).toContain('Verbindungen › API-Schlüssel')
    expect(en.errors.token_reads_only).toContain('Connections › API keys')
    expect(de.someday.hidden).toContain('Einstellungen › Darstellung › Seitenleiste')
    expect(en.someday.hidden).toContain('Settings › Appearance › Sidebar')
    expect(de.server.languageAdded).toContain('Einstellungen › Profil › Sprache')
  })

  it('never name the places of before', () => {
    const shipped = [de, en, whatsNewDe, whatsNewEn].map(all).join('\n')
    expect(shipped.match(/API-Token|API tokens?\b|Einstellungen, Server|Settings, Server|Einstellungen, Profil|Settings, Profile|Mein Konto, |My account, |„Seitenleiste“|“Sidebar”/g)).toBeNull()
  })
})
