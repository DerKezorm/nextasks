// Taking turns ("Reihum"): the switch in the detail of a repeating task in a shared space, the row of people in their
// order, "Alex's turn" in the row, and the turn moving on when the task is ticked off.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { localDay } from '../lib/due'
import { afterCompletion, offered, pickAssignee, turnOf, whoseTurn } from '../sync/rotation'
import { smallWorld } from '../test/fakeServer'
import { button, click, drag, mount, press, row, settle, unmount } from '../test/harness'

afterEach(unmount)

const today = localDay()

function world(turns = false) {
  const w = smallWorld()
  const taking = turns ? { rotation: [w.robin, w.alex], assignees: [w.robin] } : {}
  const bins = w.server.addReminder(w.home, 'Bins out', { due_date: today, repeat: 'FREQ=DAILY', repeat_from: 'due', ...taking })
  const plain = w.server.addReminder(w.home, 'Call grandma')
  return { ...w, bins, plain }
}

const order = (page: HTMLElement) => [...page.querySelectorAll('[data-testid="rotation-person"]')].map((li) => li.textContent?.trim())

describe('whose turn it is', () => {
  it('reads the first assignee in the rotation and moves on after who ticked it off', () => {
    expect(whoseTurn([1, 2, 3], [9, 2])).toBe(2)
    expect(whoseTurn([1, 2, 3], [])).toBe(1)
    expect(afterCompletion([1, 2, 3], [1], 1)).toBe(2)
    expect(afterCompletion([1, 2, 3], [1], 3)).toBe(1)
    expect(afterCompletion([1, 2, 3], [3], 9)).toBe(1)
    expect(turnOf({ rotation: [1, 2], assignees: [2], repeat: 'FREQ=DAILY', due_date: today })).toEqual({ now: 2, then: 1 })
    expect(turnOf({ rotation: [1, 2], assignees: [2], repeat: null, due_date: today })).toBeNull()
  })

  it("makes it someone's turn from a menu, which offers the people of the row in their order", () => {
    const turns = { rotation: [2, 1], assignees: [2], repeat: 'FREQ=DAILY', due_date: today }
    expect(pickAssignee(turns, 1)).toEqual([1])
    expect(pickAssignee(turns, 3)).toEqual([2])
    expect(pickAssignee({ ...turns, rotation: [] }, 1)).toEqual([2, 1])
    expect(pickAssignee({ ...turns, rotation: [] }, 2)).toEqual([])
    const members = [{ account_id: 1 }, { account_id: 2 }, { account_id: 3 }]
    expect(offered(turns, members).map((m) => m.account_id)).toEqual([2, 1])
    expect(offered({ ...turns, repeat: null }, members)).toHaveLength(3)
  })
})

describe('taking turns in the detail', () => {
  it('switches on with everybody of the space, shows whose turn it is and who comes after', async () => {
    const { server, home, bins, robin, alex } = world()
    const page = await mount(server, `/lists/${home}?reminder=${bins}`)
    await click(page.querySelector('[data-testid="rotation-switch"]'))
    expect(server.data('reminder', bins)!.rotation).toEqual([robin, alex])
    expect(server.data('reminder', bins)!.assignees).toEqual([robin])
    expect(page.querySelector('[data-testid="rotation-now"]')?.textContent).toBe('Robin’s turn · then Alex')
    expect(order(page)).toEqual(['1RRobin', '2AAlex'])
    expect(row(page, 'Bins out')?.querySelector('[data-testid="turn"]')?.textContent).toBe('Robin’s turn')
    expect(row(page, 'Bins out')?.querySelector('[data-testid="turn-avatar"]')).not.toBeNull()
    // The chips of the assignees give way to the row.
    expect(page.querySelector('[data-testid="detail"] [role="group"][aria-label="Assigned to"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('moves on when it is ticked off, and the done copy keeps whose turn it was', async () => {
    const { server, home, bins, robin, alex } = world(true)
    const page = await mount(server, `/lists/${home}`)
    expect(row(page, 'Bins out')?.querySelector('[data-testid="turn"]')?.textContent).toBe('Robin’s turn')
    await click(row(page, 'Bins out')?.querySelector('button[role="checkbox"]'))
    expect(server.data('reminder', bins)!.assignees).toEqual([alex])
    const copy = [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === 'Bins out' && r.data.completed_at)
    expect(copy?.data.assignees).toEqual([robin])
    expect(row(page, 'Bins out')?.querySelector('[data-testid="turn"]')?.textContent).toBe('Alex’s turn')
  })

  it('orders by dragging or with Alt and the arrows, and makes someone the one whose turn it is', async () => {
    const { server, home, bins, robin, alex } = world(true)
    const page = await mount(server, `/lists/${home}?reminder=${bins}`)
    const people = () => [...page.querySelectorAll('[data-testid="rotation-person"]')]
    await drag(people()[1], people()[0])
    expect(server.data('reminder', bins)!.rotation).toEqual([alex, robin])
    await press(people()[1].querySelector('button'), 'ArrowUp')
    expect(server.data('reminder', bins)!.rotation, 'without Alt nothing moves').toEqual([alex, robin])
    await act(async () => {
      people()[1].querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    })
    await settle()
    expect(server.data('reminder', bins)!.rotation).toEqual([robin, alex])
    await click(button(page, 'Make it Alex’s turn'))
    expect(server.data('reminder', bins)!.assignees).toEqual([alex])
    await click(page.querySelector('[data-testid="rotation-switch"]'))
    expect(server.data('reminder', bins)!.rotation).toEqual([])
    expect(server.data('reminder', bins)!.assignees, 'off: the one whose turn it was stays assigned').toEqual([alex])
  })

  it('offers it only on a repeating task', async () => {
    const { server, home, plain } = world()
    const page = await mount(server, `/lists/${home}?reminder=${plain}`)
    expect(page.querySelector('[data-testid="rotation-switch"]')).toBeNull()
    expect(page.querySelector('[data-testid="detail"]')?.textContent).toContain('Taking turns works for repeating tasks.')
  })
})
