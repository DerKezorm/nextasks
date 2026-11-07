import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'

import { CHANGE_AFTER_MS, NoteBridge, type Message } from './bridge'

const ID = '0b0c1f9e-8a51-4c33-9a43-1e7a9d1c2b3a'

async function open(text: string, attachments: string[] = []) {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  const posts: Message[] = []
  const bridge = new NoteBridge(root, (m) => posts.push(m))
  await bridge.load({ text, placeholder: 'Notiz hinzufügen …', attachments, words: { removed: 'Bild entfernt', picture: 'Bild', open: 'Öffnen' } })
  const view = (bridge as unknown as { editor: { ctx: { get: (key: unknown) => import('@milkdown/kit/prose/view').EditorView } } }).editor.ctx.get(editorViewCtx)
  return { root, posts, bridge, view }
}

// jsdom draws nothing: ProseMirror asks where the selection is when it scrolls to it.
beforeAll(() => {
  const none = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Element.prototype.getClientRects ??= none
  Range.prototype.getClientRects ??= none
  Range.prototype.getBoundingClientRect ??= rect
})

const changes = (posts: Message[]) => posts.filter((m): m is Extract<Message, { type: 'change' }> => m.type === 'change').map((m) => m.text)

describe('the note editor of the app', () => {
  it('shows the Markdown formatted and gives the same Markdown back', async () => {
    const { root, bridge } = await open('## Plan\n\nErst **das**, ~~nicht~~ *jenes*.\n\n- [ ] Milch\n- [x] Brot\n')
    expect(root.querySelector('h2')?.textContent).toBe('Plan')
    expect(root.querySelector('strong')?.textContent).toBe('das')
    expect(root.querySelectorAll('li[data-item-type="task"]').length).toBe(2)
    expect(bridge.markdown()).toContain('**das**')
    expect(bridge.markdown()).toContain('~~nicht~~')
    expect(bridge.markdown()).toContain('* [x] Brot')
  })

  it('makes a word bold from the key row and tells the app after a pause, or at once on blur', async () => {
    vi.useFakeTimers()
    try {
      const { posts, bridge, view } = await open('Vom Bäcker Vollkorn')
      const start = 'Vom Bäcker '.length + 1
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 'Vollkorn'.length)))
      bridge.command('bold')
      expect(changes(posts)).toEqual([])
      vi.advanceTimersByTime(CHANGE_AFTER_MS + 10)
      expect(changes(posts)).toEqual(['Vom Bäcker **Vollkorn**\n'])
      expect(posts.some((m) => m.type === 'state' && m.bold)).toBe(true)
      bridge.command('italic')
      bridge.blur()
      expect(changes(posts).at(-1)).toBe('Vom Bäcker ***Vollkorn***\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops what was not told when another note is loaded', async () => {
    vi.useFakeTimers()
    try {
      const { posts, bridge, view } = await open('eins')
      view.dispatch(view.state.tr.insertText(' zwei', view.state.doc.content.size - 1))
      const loading = bridge.load({ text: 'andere Aufgabe' })
      vi.advanceTimersByTime(CHANGE_AFTER_MS + 10)
      await vi.runAllTimersAsync()
      await loading
      expect(changes(posts)).toEqual([])
      expect(bridge.markdown()).toBe('andere Aufgabe\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts a picture the app made in as an attachment and shows it from the app scheme', async () => {
    const { root, posts, bridge } = await open('Hafen:')
    bridge.command('picture', { id: ID.toUpperCase(), name: 'Hafen.png' })
    bridge.blur()
    expect(changes(posts).at(-1)).toContain(`![Hafen](attachment:${ID})`)
    await Promise.resolve()
    expect(root.querySelector(`img[data-attachment="${ID}"]`)?.getAttribute('src')).toBe(`nextasks-file://${ID}`)
  })

  it('never loads a picture from elsewhere and says when an attachment is gone', async () => {
    const { root } = await open(`![Spur](https://tracker.example/p.png)\n\n![Alt](attachment:${ID})\n`)
    expect(root.querySelector('img:not(.ProseMirror-separator)')).toBeNull()
    expect(root.querySelector('[data-foreign-picture]')?.textContent).toBe('Bild: Spur')
    expect(root.querySelector('[data-removed]')?.textContent).toBe('Bild entfernt')
  })

  it('makes a link and a checklist from the keys', async () => {
    const { bridge } = await open('Fahrplan')
    bridge.command('link', { href: 'https://ferry.example.com', text: 'Seite' })
    expect(bridge.markdown()).toContain('[Seite](https://ferry.example.com)')
    bridge.command('link', { href: 'javascript:alert(1)' })
    expect(bridge.markdown()).not.toContain('javascript')
    bridge.command('checklist')
    expect(bridge.markdown()).toMatch(/^\* \[ \] /)
  })

  it('takes text from outside and shows the placeholder when empty', async () => {
    const { root, bridge } = await open('')
    expect(root.dataset.empty).toBe('true')
    expect(root.style.getPropertyValue('--note-placeholder')).toContain('Notiz hinzufügen')
    bridge.setText('Neu')
    expect(bridge.markdown()).toBe('Neu\n')
    expect(root.dataset.empty).toBeUndefined()
  })
})
