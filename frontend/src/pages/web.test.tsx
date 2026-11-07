// The main ways through the web, against the fake server: tiles, quick entry, ticking off, the detail pane with
// repetition, sections and columns, dragging, completed ones, trash, search, keys, members, invitations, settings.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { localDay } from '../lib/due'
import { addDays } from '../sync/repeat'
import { TILE_IDS } from '../sync/tiles'
import { FakeServer, smallWorld } from '../test/fakeServer'
import { blur, button, choose, click, drag, focus, mount, press, row, settle, submit, titles, type, unmount, where } from '../test/harness'

afterEach(unmount)

const today = localDay()

function reminder(server: FakeServer, title: string) {
  return [...server.rows.values()].find((r) => r.kind === 'reminder' && r.data.title === title)
}

function world() {
  const w = smallWorld()
  const { server, home, privateList, robin, alex } = w
  server.addReminder(home, 'Overdue bins', { due_date: addDays(today, -1) })
  server.addReminder(home, 'Today at nine', { due_date: today, due_time: '09:00' })
  server.addReminder(home, 'Today without time', { due_date: today })
  server.addReminder(home, 'Next week', { due_date: addDays(today, 7), flagged: true })
  server.addReminder(home, 'Mine', { assignees: [robin] })
  server.addReminder(home, 'Alex only', { assignees: [alex] })
  server.addReminder(home, 'Done already', { completed_at: new Date().toISOString(), completed_by: robin })
  server.addReminder(privateList, 'Private thought')
  return w
}

type NoteView = { state: { tr: { insertText: (text: string, from?: number) => unknown }; doc: { textContent: string } }; dispatch: (tr: unknown) => void; dom: HTMLElement }

/** The note editor of the open detail, once its lazily loaded code is there. */
async function noteEditor(page: HTMLElement): Promise<NoteView> {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const el = page.querySelector('[data-testid="note-editor"] [data-testid="notes"]') as (HTMLElement & { nextasksEditor?: NoteView }) | null
    if (el?.nextasksEditor) return el.nextasksEditor
    await settle()
  }
  throw new Error('no note editor')
}

/** Types into the note and leaves it, which saves. */
async function writeNote(page: HTMLElement, text: string, at?: number): Promise<void> {
  const editor = await noteEditor(page)
  await act(async () => editor.dispatch(editor.state.tr.insertText(text, at)))
  await act(async () => void editor.dom.dispatchEvent(new FocusEvent('blur')))
  await settle()
}

describe('the tiles', () => {
  it('count open reminders by the rules of the data model', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    const count = (tile: string) => page.querySelector(`[data-testid="tile-count-${tile}"]`)?.textContent
    expect(count('today')).toBe('3')
    expect(count('scheduled')).toBe('4')
    expect(count('all')).toBe('7')
    expect(count('flagged')).toBe('1')
    expect(count('assigned')).toBe('1')
    expect(page.querySelector('[data-testid="tile-count-done"]')).toBeNull()
  })

  it('show Today sorted: by date, without a time before with one', async () => {
    const { server } = world()
    const page = await mount(server, '/today')
    expect(titles(page)).toEqual(['Overdue bins', 'Today without time', 'Today at nine'])
  })

  it('show Completed with the latest first', async () => {
    const { server, home } = world()
    server.addReminder(home, 'Done just now', { completed_at: new Date(Date.now() + 1000).toISOString() })
    const page = await mount(server, '/done')
    expect(titles(page)).toEqual(['Done just now', 'Done already'])
  })
})

describe('the own look (docs "Aussehen")', () => {
  it('shows a task with a tick box, the priority as a word and a bookmark, never "!!" or a flag', async () => {
    const { server, home } = world()
    server.addReminder(home, 'Urgent one', { priority: 3, flagged: true })
    const page = await mount(server, `/lists/${home}`)
    const urgent = row(page, 'Urgent one')!
    expect(urgent.querySelector('[role="checkbox"]')?.className).toContain('nt-box')
    expect(urgent.querySelector('[data-testid="priority"]')?.textContent).toBe('High')
    expect(urgent.textContent).not.toContain('!')
    expect(urgent.querySelector('svg.lucide-bookmark')).not.toBeNull()
    expect(page.querySelector('main svg.lucide-flag')).toBeNull()
  })

  it('shows a small note sign in the row, never the note or its Markdown', async () => {
    const { server, home } = world()
    server.addReminder(home, 'With a note', { notes: '**Spiegel** nicht vergessen' })
    const page = await mount(server, `/lists/${home}`)
    const noted = row(page, 'With a note')!
    expect(noted.querySelector('[data-testid="has-note"]')).not.toBeNull()
    expect(noted.textContent).not.toContain('Spiegel')
    expect(row(page, 'Mine')!.querySelector('[data-testid="has-note"]')).toBeNull()
  })

  it('shows the collections as rows without coloured grounds, and no number where there is nothing', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/today')
    const rows = [...page.querySelectorAll('[data-testid^="tile-"]:not([data-testid^="tile-count"])')]
    expect(rows).toHaveLength(6)
    expect(rows.every((r) => !(r as HTMLElement).style.background)).toBe(true)
    expect(page.querySelector('[data-testid^="tile-count-"]')).toBeNull()
  })

  it('heads a list with its plaque and the title in the colour of text, and offers "New task"', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const head = page.querySelector('main header')!
    expect(head.querySelector('[data-plaque]')).not.toBeNull()
    expect((head.querySelector('h1') as HTMLElement).style.color).toBe('')
    expect(page.querySelector('[data-testid="new-reminder"]')?.textContent).toBe('New task')
    expect(page.textContent).not.toMatch(/reminder/i)
  })
})

describe('making and ticking off', () => {
  it('reads the quick entry and makes the reminder in the list', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const field = page.querySelector('[data-testid="quick-entry"]')
    await type(field, 'Call plumber tomorrow 9am #house !!')
    expect(page.querySelector('[data-testid="quick-chips"]')?.textContent).toContain('09:00')
    await submit(field)
    const made = reminder(server, 'Call plumber')!
    expect(made.data).toMatchObject({ list_id: home, due_date: addDays(today, 1), due_time: '09:00', tags: ['house'], priority: 2 })
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('ticks off with the tick box and hides the done one', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await click(row(page, 'Mine')?.querySelector('[role="checkbox"]'))
    expect(reminder(server, 'Mine')!.data.completed_at).not.toBeNull()
    expect(row(page, 'Mine')).toBeUndefined()
  })

  it('shows and deletes completed ones of a list, and brings one back from the trash', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await click(button(page, 'More about the list'))
    await click(button(page, 'Show completed'))
    expect(row(page, 'Done already')).toBeDefined()
    await click(button(page, 'More about the list'))
    await click(button(page, 'Delete completed (one)'))
    expect(reminder(server, 'Done already')!.data.deleted_at).not.toBeNull()
    await click(page.querySelector('a[href="/trash"]'))
    expect(page.querySelector('[data-testid="trash-reminders"]')?.textContent).toContain('Done already')
    await click(button(page, 'Restore “Done already”'))
    expect(reminder(server, 'Done already')!.data.deleted_at).toBeNull()
  })
})

describe('the detail pane', () => {
  it('saves title on leaving the field, the mark and priority at once', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const detail = page.querySelector('[data-testid="detail"]')!
    const title = detail.querySelector('input[aria-label="Title"]')
    await focus(title)
    await type(title, 'Mine, renamed')
    await blur(title)
    await click(button(detail, 'Mark'))
    await click(button(detail, 'High'))
    expect(server.data('reminder', id)).toMatchObject({ title: 'Mine, renamed', flagged: true, priority: 3 })
  })

  it('sets a repetition through the dialog in words', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Next week')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    await click(page.querySelector('[data-testid="repeat-open"]'))
    await choose(page.querySelector('select[aria-label="Repeat"]'), 'WEEKLY')
    await type(page.querySelector('input[aria-label="Every"]'), '2')
    await settle()
    expect(page.querySelector('[data-testid="repeat-sentence"]')?.textContent).toMatch(/^Every 2 weeks on /)
    await click(button(page, 'Save'))
    expect(server.data('reminder', id)!.repeat).toMatch(/^FREQ=WEEKLY;INTERVAL=2;BYDAY=[A-Z]{2}$/)
  })

  it('adds subtasks and assigns people of the space', async () => {
    const { server, home, alex } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const detail = page.querySelector('[data-testid="detail"]')!
    const field = detail.querySelector('input[aria-label="+ Subtask"]')
    await type(field, 'First step')
    await submit(field)
    expect(reminder(server, 'First step')!.data.parent_id).toBe(id)
    await click([...detail.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.includes('Alex')))
    expect(server.data('reminder', id)!.assignees).toContain(alex)
  })

  it('gives every row its own icon, none a plus that reads like an add button', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const icons = [...page.querySelectorAll('[data-testid="detail"] svg[data-field-icon]')].map((svg) => svg.getAttribute('class')?.match(/lucide-[a-z0-9-]+/)?.[0])
    expect(icons.length).toBeGreaterThanOrEqual(8)
    expect(icons).not.toContain('lucide-plus')
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('removes a location set in the app, but cannot set one', async () => {
    const { server, home } = world()
    const id = server.addReminder(home, 'At the shop', { location: { name: 'Corner shop', lat: 1, lon: 2, radius_m: 100, on: 'arrive' } })
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    expect(page.querySelector('[data-testid="detail"]')?.textContent).toContain('When arriving: Corner shop')
    await click(button(page, 'Remove'))
    expect(server.data('reminder', id)!.location).toBeNull()
  })
})

describe('the detail as a card over the blurred page', () => {
  const openRow = async (page: HTMLElement, title: string) => click(row(page, title)?.querySelector('button:not([role="checkbox"])'))

  it('opens as a modal dialog with the focus inside, and Escape gives the focus back to the row', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await openRow(page, 'Mine')
    const detail = page.querySelector('[data-testid="detail"]')!
    expect(detail.getAttribute('role')).toBe('dialog')
    expect(detail.getAttribute('aria-modal')).toBe('true')
    expect(detail.closest('[data-testid="detail-veil"]')).not.toBeNull()
    expect(detail.contains(document.activeElement)).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    await press(document.activeElement, 'Escape')
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
    expect(where.path).toBe(`/lists/${home}`)
    expect(document.activeElement).toBe(row(page, 'Mine'))
    expect(document.body.style.overflow).toBe('')
  })

  it('closes by a click on the ground around it, not by one inside', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await openRow(page, 'Mine')
    const detail = page.querySelector('[data-testid="detail"]')!
    await act(async () => detail.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(page.querySelector('[data-testid="detail"]')).not.toBeNull()
    const veil = page.querySelector('[data-testid="detail-veil"]')!
    await act(async () => veil.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    await settle()
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
  })

  it('keeps Tab inside the card and leafs through the tasks with the arrows and j and k', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const order = titles(page)
    await openRow(page, order[1])
    const detail = () => page.querySelector<HTMLElement>('[data-testid="detail"]')!
    const fields = [...detail().querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter((el) => el.tabIndex >= 0 && el.getAttribute('type') !== 'file')
    await focus(fields.at(-1))
    await press(fields.at(-1), 'Tab')
    expect(document.activeElement).toBe(fields[0])
    await press(detail(), 'ArrowDown')
    expect(detail().querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe(order[2])
    await press(detail(), 'k')
    await press(detail(), 'k')
    expect(detail().querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe(order[0])
  })
})

describe('the detail as a column on the right', () => {
  it('is switched on and off by the small button of a row, and shows another task on its button', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const toggle = (title: string) => row(page, title)!.querySelector<HTMLButtonElement>('[data-testid="pane-toggle"]')!
    await click(toggle('Mine'))
    const pane = () => page.querySelector('[data-testid="detail-pane"]')
    expect(pane()?.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe('Mine')
    expect(toggle('Mine').getAttribute('aria-pressed')).toBe('true')
    expect(toggle('Mine').title).toBe('Show or hide the details in the side column')
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
    await click(toggle('Alex only'))
    expect(pane()?.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe('Alex only')
    expect(toggle('Mine').getAttribute('aria-pressed')).toBe('false')
    await click(toggle('Alex only'))
    expect(pane()).toBeNull()
  })

  it('opens the task of a program link (?task=) in the card, or in the column while the column is shown', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const card = await mount(server, `/lists/${home}?task=${id}`)
    expect(card.querySelector<HTMLInputElement>('[data-testid="detail"] input[aria-label="Title"]')?.value).toBe('Mine')
    const other = reminder(server, 'Alex only')!.id
    const column = await mount(server, `/lists/${home}?pane=${id}&task=${other}`)
    expect(column.querySelector<HTMLInputElement>('[data-testid="detail-pane"] input[aria-label="Title"]')?.value).toBe('Alex only')
    expect(column.querySelector('[data-testid="detail"]')).toBeNull()
  })

  it('takes a clicked task while it is shown, so does Enter on a row; without it a click opens the card', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await click(row(page, 'Mine')!.querySelector('[data-testid="pane-toggle"]'))
    await click(row(page, 'Alex only')?.querySelector('button:not([role="checkbox"])'))
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
    expect(page.querySelector('[data-testid="detail-pane"] input[aria-label="Title"]')).toHaveProperty('value', 'Alex only')
    await focus(row(page, 'Mine'))
    await press(row(page, 'Mine'), 'Enter')
    expect(page.querySelector('[data-testid="detail-pane"] input[aria-label="Title"]')).toHaveProperty('value', 'Mine')
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
    await click(row(page, 'Mine')!.querySelector('[data-testid="pane-toggle"]'))
    await click(row(page, 'Alex only')?.querySelector('button:not([role="checkbox"])'))
    expect(page.querySelector('[data-testid="detail"] input[aria-label="Title"]')).toHaveProperty('value', 'Alex only')
  })

  it('splits a wide card in two: title, notes and subtasks on the left, the fields on the right', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const columns = page.querySelector('[data-testid="detail"] [data-testid="detail-columns"]')!
    expect(columns.className).toMatch(/@min-\[860px\]:grid-cols-\[minmax\(0,1fr\)_300px\]/)
    const [main, fields] = [...columns.children]
    expect(main.getAttribute('data-part')).toBe('main')
    expect(fields.getAttribute('data-part')).toBe('fields')
    expect(main.querySelector('input[aria-label="Title"]')).not.toBeNull()
    expect(main.querySelector('[data-testid="note-editor"]')).not.toBeNull()
    expect(main.querySelector('[data-testid="subtasks"]')).not.toBeNull()
    expect(fields.querySelector('input[aria-label="Date"]')).not.toBeNull()
    expect(fields.querySelector('[role="radiogroup"]')).not.toBeNull()
    await noteEditor(page)
    expect(page.querySelector('[data-testid="note-editor"] .nt-note-root')?.getAttribute('style')).toContain('Add a note …')
    expect(page.querySelector('[data-testid="note-editor"] .nt-note-root')?.getAttribute('data-empty')).toBe('true')
  })
})

describe('"+ New task" opens an empty task in the detail', () => {
  const newTasks = (server: FakeServer, before: number) => [...server.rows.values()].filter((r) => r.kind === 'reminder').length - before
  const count = (server: FakeServer) => [...server.rows.values()].filter((r) => r.kind === 'reminder').length

  it('with the focus in its title, and closing it without a title makes nothing', async () => {
    const { server, home } = world()
    const before = count(server)
    const page = await mount(server, `/lists/${home}`)
    await click(page.querySelector('[data-testid="new-reminder"]'))
    const detail = page.querySelector('[data-testid="detail"]')!
    expect(detail.getAttribute('data-draft')).toBe('true')
    expect(document.activeElement).toBe(detail.querySelector('input[aria-label="Title"]'))
    await writeNote(page, 'only a note')
    await click(button(detail, 'Close'))
    expect(page.querySelector('[data-testid="detail"]')).toBeNull()
    expect(newTasks(server, before)).toBe(0)
  })

  it('makes exactly one task with title and note in the list of the page, N does the same', async () => {
    const { server, home } = world()
    const before = count(server)
    const page = await mount(server, `/lists/${home}`)
    await press(document.body, 'n')
    const detail = () => page.querySelector('[data-testid="detail"]')!
    const title = detail().querySelector('input[aria-label="Title"]')!
    await type(title, 'Buy paint')
    await blur(title)
    await writeNote(page, 'White, two litres')
    await click(button(detail(), 'Close'))
    expect(newTasks(server, before)).toBe(1)
    expect(reminder(server, 'Buy paint')!.data).toMatchObject({ list_id: home, notes: 'White, two litres' })
  })

  it('starts marked in "Marked" and keeps a typed title when closed without leaving the field', async () => {
    const { server, privateList } = world()
    const before = count(server)
    const page = await mount(server, '/flagged')
    await click(page.querySelector('[data-testid="new-reminder"]'))
    await type(page.querySelector('[data-testid="detail"] input[aria-label="Title"]'), 'Keep me')
    await click(button(page.querySelector('[data-testid="detail"]')!, 'Close'))
    expect(newTasks(server, before)).toBe(1)
    expect(reminder(server, 'Keep me')!.data).toMatchObject({ list_id: privateList, flagged: true })
  })
})

describe('the note as Markdown', () => {
  it('shows bold and a checklist without their marks, and saves Markdown', async () => {
    const { server, home } = world()
    const id = server.addReminder(home, 'Shopping', { notes: 'Das ist **fett**\n\n- [ ] Milch\n- [x] Brot' })
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const editor = await noteEditor(page)
    expect(editor.dom.querySelector('strong')?.textContent).toBe('fett')
    expect(editor.dom.querySelector('li[data-item-type="task"][data-checked="false"]')?.textContent).toBe('Milch')
    expect(editor.dom.querySelector('li[data-item-type="task"][data-checked="true"]')?.textContent).toBe('Brot')
    expect(editor.dom.textContent).not.toContain('**')
    await writeNote(page, ' und mehr', 1 + 'Das ist fett'.length)
    expect(server.data('reminder', id)!.notes).toMatch(/^Das ist \*\*fett und mehr\*\*\n\n[-*] \[ \] Milch\n[-*] \[x\] Brot\n?$/)
  })

  it('makes a checklist from "[] " typed at the start of a line', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const editor = (await noteEditor(page)) as NoteView & { someProp: (name: string, f: (handler: (...args: unknown[]) => boolean) => boolean) => boolean }
    await act(async () => editor.dispatch(editor.state.tr.insertText('[]', 1)))
    await act(async () => void editor.someProp('handleTextInput', (handler) => handler(editor, 3, 3, ' ')))
    await act(async () => editor.dispatch(editor.state.tr.insertText('Milch')))
    expect(editor.dom.querySelector('li[data-item-type="task"][data-checked="false"]')?.textContent).toBe('Milch')
    await act(async () => void editor.dom.dispatchEvent(new FocusEvent('blur')))
    await settle()
    expect(String(server.data('reminder', id)!.notes).trim()).toMatch(/^[-*] \[ \] Milch$/)
  })

  it('uploads a picked picture as an attachment of the task and puts the link to it in the note', async () => {
    const { server, home } = world()
    const id = reminder(server, 'Mine')!.id
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    await noteEditor(page)
    const input = page.querySelector<HTMLInputElement>('[data-testid="note-picture"]')!
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'meter.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    const editor = await noteEditor(page)
    await act(async () => void editor.dom.dispatchEvent(new FocusEvent('blur')))
    await settle()
    const attachment = [...server.rows.values()].find((r) => r.kind === 'attachment' && r.data.reminder_id === id)!
    expect(attachment.data.name).toBe('meter.png')
    expect(server.data('reminder', id)!.notes).toContain(`![meter](attachment:${attachment.id})`)
    expect(page.querySelector('[data-testid="attachments"]')?.textContent ?? '').not.toContain('meter.png')
  })

  it('never loads a picture from another address, it shows as a link', async () => {
    const { server, home } = world()
    const id = server.addReminder(home, 'Logo', { notes: 'Look: ![Logo](https://tracker.example.com/pixel.png)' })
    const asked: string[] = []
    const page = await mount(server, `/lists/${home}?reminder=${id}`)
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => (asked.push(String(url)), realFetch(url, init))) as typeof fetch
    const editor = await noteEditor(page)
    expect(editor.dom.querySelector('img:not(.ProseMirror-separator)')).toBeNull()
    const link = editor.dom.querySelector<HTMLAnchorElement>('a[data-foreign-picture]')!
    expect(link.href).toBe('https://tracker.example.com/pixel.png')
    expect(asked.some((url) => url.includes('tracker.example.com'))).toBe(false)
    globalThis.fetch = realFetch
  })

  it('refuses pictures in a task that has no title yet, with a word why', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await click(page.querySelector('[data-testid="new-reminder"]'))
    await noteEditor(page)
    await click(page.querySelector('[data-testid="note-editor"] [data-tool="picture"]'))
    expect(page.querySelector('[data-testid="note-editor"] [role="status"]')?.textContent).toContain('once the task has a title')
  })
})

describe('the context menu', () => {
  const rightClick = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })))
  const menu = () => document.querySelector('[data-testid="context-menu"]')
  const entry = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] [role^="menuitem"]')].find((b) => b.dataset.entry === label)

  it('opens on a right click at a task, marks it, and gives the focus back to the row', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const target = row(page, 'Mine')!
    await focus(target)
    await rightClick(target)
    expect(menu()?.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('data-entry')).toBe('Open')
    await click(entry('Mark'))
    expect(server.data('reminder', reminder(server, 'Mine')!.id)!.flagged).toBe(true)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it('works with the keys: Shift+F10 opens, arrows move, right opens a submenu, left and Escape go back', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const target = row(page, 'Mine')!
    await focus(target)
    await press(target, 'F10')
    expect(menu()).toBeNull()
    await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
    await settle()
    expect(menu()).not.toBeNull()
    for (let i = 0; i < 10 && document.activeElement?.getAttribute('data-entry') !== 'Priority'; i++) await press(document.activeElement, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-entry')).toBe('Priority')
    await press(document.activeElement, 'ArrowRight')
    expect(document.querySelectorAll('[data-testid="context-menu"] [role="menu"]')).toHaveLength(2)
    expect(document.activeElement?.getAttribute('data-entry')).toBe('None')
    await press(document.activeElement, 'ArrowLeft')
    expect(document.querySelectorAll('[data-testid="context-menu"] [role="menu"]')).toHaveLength(1)
    await press(document.activeElement, 'ArrowRight')
    await click(entry('High'))
    expect(server.data('reminder', reminder(server, 'Mine')!.id)!.priority).toBe(3)
    await focus(target)
    await rightClick(target)
    await press(document.activeElement, 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it('opens at a list in the sidebar and shows completed ones from there', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await rightClick(page.querySelector(`aside a[href="/lists/${home}"]`)!)
    expect(entry('Show completed')?.getAttribute('aria-checked')).toBe('false')
    await click(entry('Show completed'))
    expect(row(page, 'Done already')).toBeDefined()
  })

  it('shows a member no manager entries, and leaves the browser menu in a text field', async () => {
    const { server, family, home, alex } = world()
    server.session = alex
    const page = await mount(server, `/lists/${home}`)
    await rightClick(page.querySelector(`aside [data-space="${family}"] > div`)!)
    expect(entry('Members …')).toBeDefined()
    expect(entry('Invite …')).toBeUndefined()
    expect(entry('Move to trash')).toBeUndefined()
    await press(document.activeElement, 'Escape')
    const field = page.querySelector('[data-testid="quick-entry"]')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => void field.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
  })
})

describe('hiding a space (space_pref)', () => {
  const rightClick = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })))
  const entry = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] [role^="menuitem"]')].find((b) => b.dataset.entry === label)
  const count = (page: HTMLElement, tile: string) => page.querySelector(`[data-testid="tile-count-${tile}"]`)?.textContent ?? null
  const hiddenHead = (page: HTMLElement) => page.querySelector('[data-testid="hidden-spaces"] button[aria-expanded]')

  it('hides a space from the head’s context menu: out of the sidebar and the collections, folded at the bottom', async () => {
    const { server, family, home, robin } = world()
    const page = await mount(server, `/lists/${home}`)
    expect(count(page, 'today')).toBe('3')
    await rightClick(page.querySelector(`aside [data-space="${family}"] > div`)!)
    await click(entry('Hide space'))
    await settle()
    expect(server.rows.get(`space_pref:${robin}:${family}`)?.data.hidden).toBe(true)
    expect(page.querySelector(`aside [data-space="${family}"]`)).toBeNull()
    expect(where.path).toBe('/today')
    expect(count(page, 'today')).toBeNull()
    expect(count(page, 'all')).toBe('1')
    expect(hiddenHead(page)?.textContent).toContain('Hidden spaces (1)')
    expect(hiddenHead(page)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows it again from the folded list at the bottom', async () => {
    const { server, family, robin } = world()
    server.addPref('space_pref', family, robin, { hidden: true })
    const page = await mount(server, '/today')
    expect(page.querySelector(`aside [data-space="${family}"]`)).toBeNull()
    await click(hiddenHead(page))
    await click(page.querySelector('[data-testid="show-space-Family"]'))
    await settle()
    expect(page.querySelector(`aside [data-space="${family}"]`)).not.toBeNull()
    expect(page.querySelector('[data-testid="hidden-spaces"]')).toBeNull()
    expect(count(page, 'today')).toBe('3')
    expect(server.rows.get(`space_pref:${robin}:${family}`)?.data.hidden).toBe(false)
  })

  it('never puts a quick entry into a hidden "Private": it goes into the first list shown', async () => {
    const { server, robin, home, privateList } = world()
    const privateSpace = server.data('list', privateList)!.space_id as string
    server.addPref('space_pref', privateSpace, robin, { hidden: true })
    const page = await mount(server, '/all')
    expect(page.querySelector('[data-testid="quick-entry"]')?.getAttribute('placeholder')).toBe('New task in “Home”')
    await type(page.querySelector('[data-testid="quick-entry"]'), 'Call the plumber')
    await submit(page.querySelector('[data-testid="quick-entry"]')!.closest('form'))
    await settle()
    expect(reminder(server, 'Call the plumber')?.data.list_id).toBe(home)
  })

  it('is switched in the settings, one switch per space', async () => {
    const { server, family, robin } = world()
    const page = await mount(server, '/settings')
    const toggle = page.querySelector<HTMLInputElement>('#spaces input[aria-label="Family"]')!
    expect(toggle.checked).toBe(true)
    await click(toggle)
    await settle()
    expect(server.rows.get(`space_pref:${robin}:${family}`)?.data.hidden).toBe(true)
    expect(page.querySelector(`aside [data-space="${family}"]`)).toBeNull()
  })
})

describe('lists, sections and columns', () => {
  it('offers the entries of the list and space menus as menu items to a screen reader', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    const entries = () => [...page.querySelectorAll('[role="menu"] > *')].map((item) => item.getAttribute('role'))
    await click(button(page, 'More about the list'))
    expect(entries().length).toBeGreaterThan(3)
    expect(entries().every((role) => role === 'menuitem' || role === 'menuitemcheckbox')).toBe(true)
    await click(button(page, 'More about the list'))
    await click([...page.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => b.getAttribute('aria-label')?.startsWith('More about “')))
    expect(entries().length).toBeGreaterThan(1)
    expect(entries().every((role) => role === 'menuitem')).toBe(true)
  })

  it('makes a section, turns the list into columns, and drags a reminder into a column', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await click(button(page, 'More about the list'))
    await click(button(page, 'New section'))
    const name = page.querySelector('input[aria-label="Name of the section"]')
    await type(name, 'Later')
    await submit(name)
    const section = [...server.rows.values()].find((r) => r.kind === 'section' && r.data.name === 'Later')!
    await click(button(page, 'As columns'))
    expect(server.data('list', home)!.view).toBe('columns')
    const column = page.querySelector('section[aria-label="Later"] [role="list"]')!
    await drag(row(page, 'Mine')!, column)
    expect(reminder(server, 'Mine')!.data.section_id).toBe(section.id)
  })

  it('sorts by dragging: after another reminder, and onto one as its subtask', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await drag(row(page, 'Overdue bins')!, row(page, 'Alex only')!, 'after')
    expect(titles(page).slice(-2)).toEqual(['Alex only', 'Overdue bins'])
    await drag(row(page, 'Mine')!, row(page, 'Next week')!, 'into')
    expect(reminder(server, 'Mine')!.data.parent_id).toBe(reminder(server, 'Next week')!.id)
  })

  it('moves a reminder to another list by dropping it on the list in the sidebar', async () => {
    const { server, home, privateList } = world()
    const page = await mount(server, `/lists/${home}`)
    const target = page.querySelector(`a[href="/lists/${privateList}"]`)!.closest('li')!
    await drag(row(page, 'Mine')!, target)
    expect(reminder(server, 'Mine')!.data.list_id).toBe(privateList)
  })

  it('makes a list in a space and switches on notifications for changes', async () => {
    const { server, family } = world()
    const page = await mount(server, '/today')
    await click(button(page, 'New list'))
    await type(page.querySelector('input[maxlength="80"]'), 'Garden')
    await choose(page.querySelector('[role="dialog"] select'), family)
    await click(button(page, 'Create list'))
    const list = [...server.rows.values()].find((r) => r.kind === 'list' && r.data.name === 'Garden')!
    expect(list.data.space_id).toBe(family)
    expect(where.path).toBe(`/lists/${list.id}`)
    await click(button(page, 'More about the list'))
    await click(button(page, 'Notify me of changes'))
    expect(server.rows.get(`list_pref:1:${list.id}`)?.data.notify_changes).toBe(true)
  })
})

describe('search and keys', () => {
  it('finds by tag and by notes, done ones on request', async () => {
    const { server, home } = world()
    server.addReminder(home, 'Paint the fence', { tags: ['garden'], notes: 'white paint' })
    const page = await mount(server, '/search')
    await type(page.querySelector('[data-testid="search-field"]'), '#garden')
    await settle()
    expect(titles(page)).toEqual(['Paint the fence'])
    await type(page.querySelector('[data-testid="search-field"]'), 'already')
    await settle()
    expect(titles(page)).toEqual([])
    await click(page.querySelector('input[type="checkbox"]'))
    expect(titles(page)).toEqual(['Done already'])
  })

  it('Shift+N goes to the quick entry, X ticks off the row in focus, / opens the search', async () => {
    const { server, home } = world()
    const page = await mount(server, `/lists/${home}`)
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement?.getAttribute('data-testid')).toBe('quick-entry')
    const target = row(page, 'Mine')!
    await focus(target)
    await press(target, 'x')
    expect(reminder(server, 'Mine')!.data.completed_at).not.toBeNull()
    await press(document.body, '/')
    expect(where.path).toBe('/search')
  })
})

describe('spaces and people', () => {
  it('invites by link and changes the role of a member', async () => {
    const { server, family, alex } = world()
    const page = await mount(server, '/today')
    await click(page.querySelector(`[data-space="${family}"] button[aria-label="More about “Family”"]`))
    await click(button(page, 'Members'))
    await click(button(page, 'Create invitation link'))
    const link = (page.querySelector('input[aria-label="Invitation link"]') as HTMLInputElement).value
    expect(link).toMatch(/\/invite\/[0-9a-f]{32}$/)
    expect([...server.invites.values()]).toHaveLength(1)
    await choose(page.querySelector('select[aria-label="Role of Alex"]'), 'manager')
    expect(server.member(family, alex)!.data.role).toBe('manager')
  })

  it('takes an invitation without an account: name, password, and in the space', async () => {
    const { server, family, robin } = world()
    server.session = robin
    const made = await server.handle('POST', `/api/app/1/spaces/${family}/invites`, {}, robin)
    const secret = String((made.body as { link: string }).link.split('/invite/')[1])
    server.session = null
    const page = await mount(server, `/invite/${secret}`)
    expect(page.textContent).toContain('Robin invites you to the space “Family”.')
    await type(page.querySelector('input[autocomplete="username"]'), 'Kim')
    await type(page.querySelector('input[autocomplete="new-password"]'), 'a-long-password')
    await submit(page.querySelector('input[autocomplete="username"]'))
    const kim = [...server.accounts.values()].find((a) => a.name === 'Kim')!
    expect(server.member(family, kim.id)).toBeDefined()
    const firstList = [...server.rows.values()].find((r) => r.kind === 'list' && r.data.space_id === family)!
    expect(where.path).toBe(`/lists/${firstList.id}`)
  })

  it('switches the iPhone app and invitations off for the operator', async () => {
    const { server } = world()
    const page = await mount(server, '/settings?tab=server&sub=app')
    const toggle = (label: string) => [...page.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))?.querySelector('input')
    await click(toggle('Invitations to spaces'))
    expect(server.settings.invites_enabled).toBe(false)
    await click(toggle('Allow the iPhone app'))
    expect(server.settings.app_enabled).toBe(false)
  })

  it('invites a new account into nextasks without promising a space it cannot choose', async () => {
    const { server } = world()
    const page = await mount(server, '/settings?tab=server&sub=accounts')
    const card = page.querySelector('#invite')
    expect(card?.textContent).toContain('without a space yet')
    expect([...(card?.querySelectorAll('label') ?? [])].map((l) => l.textContent)).not.toContain('Space')
    expect(card?.textContent).not.toMatch(/with that right/)
  })

  it('pairs an iPhone with a QR code and shows it among the devices', async () => {
    const { server } = world()
    server.settings.public_url = 'https://tasks.example.com'
    const page = await mount(server, '/account?tab=connections')
    await click(page.querySelector('[data-testid="pair-start"]'))
    expect(page.querySelector('[data-testid="pair-code"]')?.textContent).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(page.querySelector('[data-testid="pairing"] img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    server.connectPairing([...server.pairings.keys()][0], 'Test phone')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    await settle()
    expect(page.querySelector('[data-testid="devices"]')?.textContent).toContain('Test phone')
  })
})

describe('own filters and the sidebar overview (filter, tile_pref)', () => {
  const rightClick = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })))
  const entry = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] [role^="menuitem"]')].find((b) => b.dataset.entry === label)
  const filterRow = (page: HTMLElement, name: string) => page.querySelector(`aside [data-testid="filter-${name}"]`)
  const ownFilter = (server: FakeServer, owner: number, name: string) => [...server.rows.values()].find((r) => r.kind === 'filter' && r.owner === owner && r.data.name === name)

  it('shows the filters under "Filters" with their number of open tasks; a hidden one stays out', async () => {
    const { server, robin, home } = world()
    const dueHome = server.addFilter(robin, 'Due at home', { due: ['overdue', 'today'], lists: [home] }, { color: 'orange', icon: 'house' })
    server.addFilter(robin, 'Done lately', { state: 'completed', done: ['last7'] })
    server.addFilter(robin, 'Secret', {}, { hidden: true })
    const page = await mount(server, '/all')
    const section = page.querySelector('aside [data-testid="filters"]')!
    expect([...section.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Due at home3', 'Done lately'])
    expect(page.querySelector('[data-testid="filter-count-Due at home"]')?.textContent).toBe('3')
    expect(page.querySelector('[data-testid="filter-count-Done lately"]')).toBeNull()
    expect(filterRow(page, 'Secret')).toBeNull()
    await click(filterRow(page, 'Due at home'))
    expect(where.path).toBe(`/filters/${dueHome}`)
    expect(page.querySelector('#filter-title')?.textContent).toBe('Due at home')
    expect(titles(page)).toEqual(['Overdue bins', 'Today without time', 'Today at nine'])
  })

  it('shows completed ones on the page of a filter of completed tasks, newest first', async () => {
    const { server, robin, home } = world()
    server.addReminder(home, 'Done before', { completed_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), completed_by: robin })
    const done = server.addFilter(robin, 'Done lately', { state: 'completed', done: ['today', 'yesterday', 'last7'] })
    const page = await mount(server, `/filters/${done}`)
    expect(titles(page)).toEqual(['Done already', 'Done before'])
  })

  it('leaves out the collections one hid', async () => {
    const { server, robin } = world()
    server.addPref('tile_pref', TILE_IDS.today, robin, { hidden: true })
    server.addPref('tile_pref', TILE_IDS.done, robin, { hidden: true })
    const page = await mount(server, '/all')
    const tiles = [...page.querySelectorAll('aside nav a')].map((a) => a.getAttribute('data-testid'))
    expect(tiles).toEqual(['tile-scheduled', 'tile-all', 'tile-flagged', 'tile-assigned'])
  })

  it('hides and deletes a filter from its context menu', async () => {
    const { server, robin } = world()
    const keep = server.addFilter(robin, 'Keep out')
    const gone = server.addFilter(robin, 'Away with it')
    const page = await mount(server, `/filters/${gone}`)
    await rightClick(filterRow(page, 'Keep out')!)
    await click(entry('Hide filter'))
    await settle()
    expect(server.rows.get(`filter:${robin}:${keep}`)?.data.hidden).toBe(true)
    expect(filterRow(page, 'Keep out')).toBeNull()
    await rightClick(filterRow(page, 'Away with it')!)
    await click(entry('Delete'))
    expect(entry('Delete')?.textContent).toContain('Delete the filter for good')
    await click(entry('Delete'))
    await settle()
    expect(server.rows.has(`filter:${robin}:${gone}`)).toBe(false)
    expect(where.path).toBe('/today')
  })

  it('switches collections and filters with the eyes of the settings; a hidden filter stays there', async () => {
    const { server, robin } = world()
    const secret = server.addFilter(robin, 'Secret', {}, { hidden: true })
    const page = await mount(server, '/settings')
    const card = page.querySelector('#sidebar')!
    expect([...card.querySelectorAll('[data-testid^="pref-tile-"][data-testid$="-eye"]')]).toHaveLength(6)
    const eye = card.querySelector('[data-testid="pref-tile-today-eye"]')!
    expect(eye.getAttribute('aria-pressed')).toBe('true')
    expect(eye.getAttribute('aria-label')).toBe('Hide “Today”')
    await click(eye)
    await settle()
    expect(server.rows.get(`tile_pref:${robin}:${TILE_IDS.today}`)?.data.hidden).toBe(true)
    expect(page.querySelector('aside [data-testid="tile-today"]')).toBeNull()
    expect(card.querySelector('[data-testid="pref-tile-today-eye"]')?.getAttribute('aria-pressed')).toBe('false')

    expect(filterRow(page, 'Secret')).toBeNull()
    expect(card.querySelector('[data-testid="pref-filter-Secret-eye"]')?.getAttribute('aria-pressed')).toBe('false')
    await click(card.querySelector('[data-testid="pref-filter-Secret-eye"]'))
    await settle()
    expect(server.rows.get(`filter:${robin}:${secret}`)?.data.hidden).toBe(false)
    expect(filterRow(page, 'Secret')).not.toBeNull()
    await click(card.querySelector('[data-testid="pref-filter-Secret-eye"]'))
    await settle()
    expect(filterRow(page, 'Secret')).toBeNull()
    // Still to be changed from here.
    await click(card.querySelector('[data-testid="pref-filter-Secret-edit"]'))
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit filter')
  })

  it('makes a filter in the editor: completed today in the list Home', async () => {
    const { server, robin, home } = world()
    const page = await mount(server, '/today')
    await click(page.querySelector('[data-testid="new-filter"]'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('New filter')
    await type(dialog.querySelector('input.nc-field'), 'Done at home today')
    expect(dialog.querySelector('[data-testid="condition-done"]')).toBeNull()
    await click(dialog.querySelector('[data-testid="state-completed"]'))
    expect(dialog.querySelector('[data-testid="condition-due"]')).toBeNull()
    await click(dialog.querySelector('[data-testid="done-today"]'))
    await click(dialog.querySelector('[data-testid="place-list-Home"]'))
    expect(dialog.querySelector('[data-testid="place-list-Home"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(dialog.querySelector('[data-testid="filter-matches"]')?.textContent).toBe('Matches one task right now.')
    await click(button(dialog, 'Create filter'))
    await settle()
    const made = ownFilter(server, robin, 'Done at home today')!
    expect(made.data).toMatchObject({ color: 'blue', icon: 'filter', hidden: false, rules: { state: 'completed', done: ['today'], lists: [home] } })
    expect(where.path).toBe(`/filters/${made.id}`)
    expect(titles(page)).toEqual(['Done already'])
    expect(filterRow(page, 'Done at home today')).not.toBeNull()
  })

  it('offers people, priorities and tags, and keeps conditions it does not know when it changes a filter', async () => {
    const { server, robin, home, alex } = world()
    const id = server.addFilter(robin, 'Mixed', { due: ['today', 'someday'], future: { x: 1 }, assignees: [alex] })
    server.addReminder(home, 'Tagged', { tags: ['Garden'], priority: 2 })
    const page = await mount(server, `/filters/${id}`)
    await click(page.querySelector('[data-testid="edit-filter"]'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('[data-testid="due-today"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(dialog.querySelector(`[data-testid="who-${alex}"]`)?.getAttribute('aria-pressed')).toBe('true')
    expect(dialog.querySelector(`[data-testid="who-${alex}"]`)?.textContent).toBe('Alex')
    await click(dialog.querySelector(`[data-testid="who-${alex}"]`))
    await click(dialog.querySelector('[data-testid="who-me"]'))
    await click(dialog.querySelector('[data-testid="priority-2"]'))
    await click(button(dialog, '#Garden'))
    await type(dialog.querySelector('input[aria-label="Add a tag"]'), '#Shed')
    await press(dialog.querySelector('input[aria-label="Add a tag"]'), 'Enter')
    await click(dialog.querySelector('[data-testid="flagged"]'))
    await click(button(dialog, 'Save'))
    await settle()
    expect(server.rows.get(`filter:${robin}:${id}`)?.data.rules).toEqual({ future: { x: 1 }, state: 'open', due: ['today', 'someday'], flagged: true, assignees: ['me'], priority: [2], tags: ['Garden', 'Shed'] })
  })

  it('offers neither filters nor the eyes when the server does not know them', async () => {
    const { server } = world()
    server.features = server.features.filter((word) => word !== 'filters')
    const page = await mount(server, '/settings')
    expect(page.querySelector('[data-testid="new-filter"]')).toBeNull()
    expect(page.querySelector('#sidebar')).toBeNull()
    expect(page.querySelector('#spaces')).not.toBeNull()
  })
})
