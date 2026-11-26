/**
 * MCP decision 15: a line of a task's history names the AI program that made the change ("Anna (MCP · Laptop)"), as
 * nexnotes shows it; a change by the person's own hand, or from before, stays as it was.
 */
import { describe, expect, it } from 'vitest'

import i18n from '../i18n'
import { byWho } from './comments'

describe('who made a change', () => {
  it('names the AI program behind a change, and nothing else', async () => {
    await i18n.changeLanguage('de')
    const viaMcp = (key: string) => i18n.t('comments.event.viaMcp', { key })
    expect(byWho('Anna', 'mcp:Laptop', viaMcp)).toBe('Anna (MCP · Laptop)')
    expect(byWho('Anna', '', viaMcp)).toBe('Anna')
    expect(byWho('Anna', undefined, viaMcp)).toBe('Anna')
  })
})
