import { describe, expect, it } from 'vitest'

import { untilBack } from './restart'

/** A server that answers as the list says, one entry per look (the last one stays). */
function server(states: boolean[]) {
  let look = 0
  const answers = async () => states[Math.min(look++, states.length - 1)]
  return { answers, looks: () => look }
}

const noWait = async () => undefined

describe('untilBack', () => {
  it('waits while the server is still up before it goes away, then until it answers again', async () => {
    const seen = server([true, true, false, false, false, true])
    await untilBack(seen.answers, noWait, { step: 1000, quickBack: 60_000 })
    expect(seen.looks()).toBe(6)
  })

  it('does not reload into the gap: a server that stays away keeps the page waiting', async () => {
    const seen = server([false])
    await untilBack(seen.answers, noWait, { step: 1000, giveUp: 30_000 })
    expect(seen.looks()).toBe(31)
  })

  it('takes a server that came back between two looks once the quick time is over', async () => {
    const seen = server([true])
    await untilBack(seen.answers, noWait, { step: 1000, quickBack: 5000 })
    expect(seen.looks()).toBe(6)
  })
})
