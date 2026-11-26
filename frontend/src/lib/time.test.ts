/**
 * E65 (ui 1.1.2) in the settings: a moment in the one form of all apps ("heute, 14:05", "gestern, 14:05", else
 * "24.02.2027, 14:05"), a day ("24.02.2027"), the time of day ("14:05", 24 hours), each in the account's own time zone
 * (E14), whatever zone the browser has.
 */
import { describe, expect, it } from 'vitest'

import { clockIn, dayOf, momentIn } from './time'

const AT = '2027-02-24T13:05:00.000Z'

describe('the settings write a moment', () => {
  it('as a day and a time, two digits each, in the account\'s zone', () => {
    const later = new Date('2027-03-10T12:00:00.000Z')
    expect(momentIn(AT, 'de', 'Europe/Berlin', later)).toBe('24.02.2027, 14:05')
    expect(momentIn(AT, 'en', 'Europe/Berlin', later)).toBe('24/02/2027, 14:05')
    expect(momentIn(AT, 'de', 'America/New_York', later)).toBe('24.02.2027, 08:05')
    expect(momentIn('2027-02-24T23:30:00.000Z', 'de', 'Europe/Berlin', later)).toBe('25.02.2027, 00:30')
  })

  it('says today and yesterday as the account\'s clock reckons them', () => {
    expect(momentIn(AT, 'de', 'Europe/Berlin', new Date('2027-02-24T20:00:00.000Z'))).toBe('heute, 14:05')
    expect(momentIn(AT, 'en', 'Europe/Berlin', new Date('2027-02-25T09:00:00.000Z'))).toBe('yesterday, 14:05')
    // At 17:00 in Berlin it is already the next day in Tokyo: what was today in Berlin was yesterday there.
    expect(momentIn('2027-02-24T14:30:00.000Z', 'de', 'Europe/Berlin', new Date('2027-02-24T16:00:00.000Z'))).toBe('heute, 15:30')
    expect(momentIn('2027-02-24T14:30:00.000Z', 'de', 'Asia/Tokyo', new Date('2027-02-24T16:00:00.000Z'))).toBe('gestern, 23:30')
  })

  it('takes the browser\'s zone for one it does not know, and leaves what is no date as it came', () => {
    const later = new Date('2027-03-10T12:00:00.000Z')
    expect(momentIn(AT, 'de', 'Mars/Olympus', later)).toMatch(/^24\.02\.2027, \d\d:05$/)
    expect(momentIn('soon', 'de', 'Europe/Berlin')).toBe('soon')
  })

  it('writes the time of day with 24 hours and a day with two digits', () => {
    expect(clockIn(AT, 'en', 'Europe/Berlin')).toBe('14:05')
    expect(clockIn('2027-02-24T02:05:00.000Z', 'en', 'Europe/Berlin')).toBe('03:05')
    expect(dayOf('2027-02-04T10:00:00.000Z', 'de')).toBe('04.02.2027')
    expect(dayOf('2027-02-04T10:00:00.000Z', 'en')).toBe('04/02/2027')
  })
})
