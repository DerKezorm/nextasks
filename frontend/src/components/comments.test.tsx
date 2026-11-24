// Comments and the history of a task (contract 0.9): in the detail of a task of a shared space, the row's speech
// bubble, `@` offering the people of the space, Enter sending, removing as "message deleted", and the search.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { mayEdit, mentionsIn, pieces, timeline, typedMention } from '../lib/comments'
import type { Comment } from '../sync/types'
import { smallWorld } from '../test/fakeServer'
import { button, click, mount, press, row, settle, type, unmount } from '../test/harness'

afterEach(async () => {
  await unmount()
})

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function comment(extra: Partial<Comment>): Comment {
  return { id: 'c', reminder_id: 'r', author_id: 1, text: '', mentions: [], attachment_id: null, created_at: ago(1), edited_at: null, removed_at: null, ...extra }
}

describe('the text of a comment', () => {
  it('cuts links and mentions of the people it names, the longest name first', () => {
    const cut = pieces('Ask @Alex Berg or @Alex, see https://example.com/a.', [
      { id: 2, name: 'Alex' },
      { id: 3, name: 'Alex Berg' },
    ])
    expect(cut).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'mention', text: '@Alex Berg', id: 3 },
      { kind: 'text', text: ' or ' },
      { kind: 'mention', text: '@Alex', id: 2 },
      { kind: 'text', text: ', see ' },
      { kind: 'link', text: 'https://example.com/a' },
      { kind: 'text', text: '.' },
    ])
    expect(pieces('@Robin is not named', [])).toEqual([{ kind: 'text', text: '@Robin is not named' }])
  })

  it('finds the @ being typed and the people a text still names', () => {
    expect(typedMention('Hi @Al', 6)).toEqual({ start: 3, query: 'Al' })
    expect(typedMention('mail@home', 9)).toBeNull()
    expect(typedMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionsIn('for @Alex', [{ id: 2, name: 'Alex' }, { id: 3, name: 'Robin' }])).toEqual([2])
  })

  it('may be changed by its author for a day, not once removed', () => {
    const now = Date.now()
    expect(mayEdit(comment({ author_id: 1 }), 1, now)).toBe(true)
    expect(mayEdit(comment({ author_id: 2 }), 1, now)).toBe(false)
    expect(mayEdit(comment({ created_at: ago(25 * 60) }), 1, now)).toBe(false)
    expect(mayEdit(comment({ removed_at: ago(0) }), 1, now)).toBe(false)
  })

  it('stands between the events in the order things happened', () => {
    const events = [{ id: 1, field: 'created', by: 1, at: ago(30), old: null, new: null }]
    const order = timeline([comment({ id: 'late', created_at: ago(1) }), comment({ id: 'early', created_at: ago(60) })], events)
    expect(order.map((e) => (e.type === 'comment' ? e.comment.id : e.event.field))).toEqual(['early', 'created', 'late'])
  })
})

function world() {
  const w = smallWorld()
  const task = w.server.addReminder(w.home, 'Bins out', { assignees: [w.alex] })
  return { ...w, task }
}

describe('the history in the detail', () => {
  it('shows comments with mentions and links, the events between them, and sends with Enter', async () => {
    const { server, robin, alex, home, task } = world()
    server.addComment(task, alex, 'Tomorrow, @Robin? https://example.com', { mentions: [robin], created_at: ago(5) })
    server.history.set(task, [
      { id: 1, field: 'created', by: robin, at: ago(60), old: null, new: null },
      { id: 2, field: 'priority', by: alex, at: ago(2), old: 0, new: 3 },
    ])
    const page = await mount(server, `/lists/${home}?reminder=${task}`)
    const detail = page.querySelector('[data-testid="detail"]')!
    expect(detail.querySelector('[data-testid="comments"] h3')?.textContent).toContain('History')
    const lines = [...detail.querySelectorAll('[data-testid="history"] > li')].map((li) => li.getAttribute('data-testid'))
    expect(lines).toEqual(['history-event', 'comment', 'history-event'])
    expect(detail.querySelector('[data-testid="history-event"]')?.textContent).toContain('Robin created the task')
    expect(detail.querySelectorAll('[data-testid="history-event"]')[1].textContent).toContain('Alex set the priority to High')
    expect(detail.querySelector('[data-testid="mention"]')?.textContent).toBe('@Robin')
    expect(detail.querySelector('[data-testid="comment-text"] a')?.getAttribute('href')).toBe('https://example.com')

    const field = detail.querySelector<HTMLTextAreaElement>('[data-testid="comment-field"]')!
    await type(field, 'Thanks @Al')
    const offered = detail.querySelector('[data-testid="mention-list"]')
    expect(offered?.textContent).toContain('Alex')
    await press(field, 'Enter')
    expect(field.value).toBe('Thanks @Alex ')
    await type(field, 'Thanks @Alex, done')
    await press(field, 'Enter')
    await settle()
    const sent = [...server.rows.values()].find((r) => r.kind === 'comment' && r.data.author_id === robin)
    expect(sent?.data).toMatchObject({ reminder_id: task, text: 'Thanks @Alex, done', mentions: [alex] })
    expect(field.value).toBe('')
    expect([...detail.querySelectorAll('[data-testid="comment-text"]')].map((p) => p.textContent)).toContain('Thanks @Alex, done')
  })

  it('removes an own comment as "Message deleted" after asking', async () => {
    const { server, robin, home, task } = world()
    const mine = server.addComment(task, robin, 'Wrong task')
    const page = await mount(server, `/lists/${home}?reminder=${task}`)
    const item = page.querySelector(`[data-comment="${mine}"]`)!
    await click(item.querySelector('[aria-label="Actions for this comment"]'))
    await click(button(item, 'Delete'))
    await click(button(document.body, 'Delete'))
    await settle()
    expect(server.data('comment', mine)?.removed_at).toBeTruthy()
    expect(page.querySelector(`[data-comment="${mine}"] [data-testid="comment-removed"]`)?.textContent).toBe('Message deleted')
  })

  it('is not there in "Private", and the row of a shared task shows how many comments it has', async () => {
    const { server, alex, home, privateList, task } = world()
    server.addComment(task, alex, 'One')
    server.addComment(task, alex, 'Two')
    server.addComment(task, alex, '', { removed_at: ago(0) })
    const own = server.addReminder(privateList, 'Alone')
    const page = await mount(server, `/lists/${home}`)
    expect(row(page, 'Bins out')?.querySelector('[data-testid="comment-count"]')?.textContent?.trim()).toBe('2')
    await unmount()
    const alone = await mount(server, `/lists/${privateList}?reminder=${own}`)
    expect(alone.querySelector('[data-testid="detail"]')).not.toBeNull()
    expect(alone.querySelector('[data-testid="comments"]')).toBeNull()
  })

  it('finds a task by the words of its comments', async () => {
    const { server, alex, task } = world()
    server.addComment(task, alex, 'The blue bin goes first')
    const page = await mount(server, '/search?q=blue%20bin')
    await act(async () => undefined)
    expect(row(page, 'Bins out')).toBeDefined()
  })
})
