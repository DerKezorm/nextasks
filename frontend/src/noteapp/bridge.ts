/**
 * The note editor alone, for the iPhone and iPad app (nextasks-ios, docs/editor-bruecke.md). The app shows
 * note-app.html in a web view, calls `window.nextasksNote` and hears `webkit.messageHandlers.nextasks`. The editor
 * never saves and never talks to a server: Markdown goes in, Markdown changes come out, pictures come from the app's
 * own scheme `nextasks-file://<attachment id>`.
 */
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { history, redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import type { Mark, MarkType } from '@milkdown/kit/prose/model'
import { Plugin, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils'

import { noteSyntax, pictureView, taskTicks, toggleChecklist } from '../lib/noteMilkdown'

export const VERSION = '1'
/** The changes the app hears: gathered for this long while typing; `blur()` sends what is open at once. */
export const CHANGE_AFTER_MS = 300
export const SCHEME = 'nextasks-file'

export type Message =
  | { type: 'ready'; version: string }
  | { type: 'change'; text: string }
  | { type: 'state'; bold: boolean; italic: boolean; strike: boolean; code: boolean; heading: number; bullets: boolean; numbers: boolean; checklist: boolean; quote: boolean }
  | { type: 'height'; px: number }
  | { type: 'focus'; on: boolean }
  | { type: 'openLink'; url: string }
  | { type: 'zoom'; id: string; name: string }
  | { type: 'error'; message: string }

export interface Theme {
  mode: 'dark' | 'light'
}

export interface LoadArgs {
  text: string
  theme?: Theme
  /** The body text size of the app (Dynamic Type), in CSS pixels. */
  fontSize?: number
  placeholder?: string
  words?: { removed: string; picture: string; open: string }
  /** The ids of the task's attachments; a picture without one shows "removed". */
  attachments?: string[]
  focus?: boolean
}

export type Post = (message: Message) => void

/** One editor in one page; `post` reaches the app. */
export class NoteBridge {
  private editor: Editor | null = null
  private making: Promise<void> | null = null
  private pending: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attachments = new Set<string>()
  private words = { removed: 'Bild entfernt', picture: 'Bild', open: 'Öffnen' }
  private lastState = ''
  private observer: ResizeObserver | null = null
  private readonly root: HTMLElement
  private readonly post: Post

  constructor(root: HTMLElement, post: Post) {
    this.root = root
    this.post = post
  }

  /** A note: the editor is made anew, so the undo history is the note's own. What was not told yet is dropped. */
  load(args: LoadArgs): Promise<void> {
    this.drop()
    if (args.theme) this.setTheme(args.theme)
    if (args.fontSize) this.setFontSize(args.fontSize)
    if (args.words) this.words = args.words
    this.attachments = new Set((args.attachments ?? []).map((id) => id.toLowerCase()))
    this.root.style.setProperty('--note-placeholder', JSON.stringify(args.placeholder ?? ''))
    this.empty(!args.text.trim())
    const before = this.editor
    this.editor = null
    const made = (async () => {
      if (before) await before.destroy()
      this.root.replaceChildren()
      const editor = this.make(args.text)
      await editor.create()
      this.editor = editor
      this.watchHeight()
      this.tellState()
      if (args.focus) this.focus()
    })().catch((error: unknown) => this.post({ type: 'error', message: String(error) }))
    this.making = made
    return made
  }

  /** Text from outside replaces what is shown; what was typed and not told yet is dropped with it. */
  setText(text: string) {
    this.drop()
    this.editor?.action(replaceAll(text))
    this.empty(!text.trim())
  }

  setTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light'
  }

  setFontSize(px: number) {
    document.documentElement.style.fontSize = `${Math.max(12, Math.min(40, px))}px`
  }

  setAttachments(ids: string[]) {
    this.attachments = new Set(ids.map((id) => id.toLowerCase()))
  }

  /** A key of the app's row above the keyboard. */
  command(name: string, args?: { href?: string; id?: string; name?: string; text?: string }) {
    const editor = this.editor
    const view = this.view()
    if (!editor || !view) return
    const call = <T>(command: { key: unknown }, payload?: T) => editor.action(callCommand(command.key as never, payload as never))
    switch (name) {
      case 'bold': call(toggleStrongCommand); break
      case 'italic': call(toggleEmphasisCommand); break
      case 'strike': call(toggleStrikethroughCommand); break
      case 'code': call(toggleInlineCodeCommand); break
      case 'heading':
        if (view.state.selection.$from.parent.type.name === 'heading') call(turnIntoTextCommand)
        else call(wrapInHeadingCommand, 2)
        break
      case 'bullets': call(wrapInBulletListCommand); break
      case 'numbers': call(wrapInOrderedListCommand); break
      case 'checklist': toggleChecklist(view, () => call(wrapInBulletListCommand)); break
      case 'quote': call(wrapInBlockquoteCommand); break
      case 'undo': call(undoCommand); break
      case 'redo': call(redoCommand); break
      case 'link': {
        const href = (args?.href ?? '').trim()
        if (!/^(https?:|mailto:)/i.test(href)) break
        if (view.state.selection.empty) {
          const mark = view.state.schema.marks.link.create({ href })
          view.dispatch(view.state.tr.insert(view.state.selection.from, view.state.schema.text(args?.text || href, [mark])))
        } else {
          call(toggleLinkCommand, { href })
        }
        break
      }
      case 'picture': {
        const id = (args?.id ?? '').toLowerCase()
        if (!/^[0-9a-f-]{36}$/.test(id)) break
        this.attachments.add(id)
        const alt = (args?.name ?? '').replace(/\.[a-z0-9]+$/i, '')
        const node = view.state.schema.nodes.image.create({ src: `attachment:${id}`, alt })
        view.dispatch(view.state.tr.replaceSelectionWith(node))
        break
      }
      case 'insertText':
        if (args?.text) view.dispatch(view.state.tr.insertText(args.text))
        break
    }
    view.focus()
  }

  focus() {
    this.view()?.focus()
  }

  /** Leaves the field and tells the app at once what was typed: before "Fertig" and before another task. */
  blur() {
    this.flush()
    const dom = this.view()?.dom
    if (dom && document.activeElement === dom) dom.blur()
  }

  /** Waits until the editor exists (tests). */
  get ready(): Promise<void> {
    return this.making ?? Promise.resolve()
  }

  markdown(): string {
    const editor = this.editor
    if (!editor) return ''
    const text = editor.ctx.get(serializerCtx)(editor.ctx.get(editorViewCtx).state.doc)
    return text.trim() ? text : ''
  }

  // MARK: inside

  private view(): EditorView | undefined {
    try {
      return this.editor?.ctx.get(editorViewCtx)
    } catch {
      return undefined
    }
  }

  private make(text: string): Editor {
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, this.root)
        ctx.set(defaultValueCtx, text)
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          attributes: { class: 'nt-note-body', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true', 'data-testid': 'notes' },
        }))
      })
      .use(noteSyntax)
      .use(history)
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              view: () => ({
                update: (view, before) => {
                  if (!view.state.doc.eq(before.doc)) {
                    const markdown = ctx.get(serializerCtx)(view.state.doc)
                    this.changed(markdown.trim() ? markdown : '')
                  }
                  this.tellState()
                },
              }),
              props: {
                handleDOMEvents: {
                  focus: () => (this.post({ type: 'focus', on: true }), false),
                  blur: () => (this.flush(), this.post({ type: 'focus', on: false }), false),
                },
                // A link opens outside, in the browser or the mail app, never in this page.
                handleClick: (view, _pos, event) => {
                  const link = (event.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null
                  if (!link || !view.dom.contains(link)) return false
                  event.preventDefault()
                  this.post({ type: 'openLink', url: link.getAttribute('href') ?? '' })
                  return true
                },
              },
            }),
        ),
      )
      .use(clipboard)
      .use(taskTicks)
      .use(
        pictureView(() => ({
          exists: (id) => this.attachments.has(id),
          source: (id) => Promise.resolve(`${SCHEME}://${id}`),
          zoom: (_url, name, id) => this.post({ type: 'zoom', id, name }),
          words: this.words,
          openLink: (url) => this.post({ type: 'openLink', url }),
        })),
      )
  }

  private changed(markdown: string) {
    this.pending = markdown
    this.empty(!markdown)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), CHANGE_AFTER_MS)
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending === null) return
    const text = this.pending
    this.pending = null
    this.post({ type: 'change', text })
  }

  private drop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private empty(on: boolean) {
    if (on) this.root.dataset.empty = 'true'
    else delete this.root.dataset.empty
  }

  private watchHeight() {
    const tell = () => this.post({ type: 'height', px: Math.ceil(document.documentElement.scrollHeight) })
    this.observer?.disconnect()
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(tell)
      this.observer.observe(this.root)
    }
    tell()
  }

  /** What the keys above the keyboard show as on. */
  tellState() {
    const view = this.view()
    if (!view) return
    const state = view.state
    const marks = state.schema.marks
    const on = (type: MarkType | undefined) => !!type && markActive(state, type)
    let heading = 0
    let bullets = false
    let numbers = false
    let checklist = false
    let quote = false
    const { $from } = state.selection
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth)
      if (node.type.name === 'heading') heading = Number(node.attrs.level) || 1
      if (node.type.name === 'blockquote') quote = true
      if (node.type.name === 'list_item' && node.attrs.checked != null) checklist = true
      if (node.type.name === 'bullet_list' && !checklist) bullets = true
      if (node.type.name === 'ordered_list') numbers = true
    }
    if (checklist) bullets = false
    const message: Message = {
      type: 'state',
      bold: on(marks.strong),
      italic: on(marks.emphasis),
      strike: on(marks.strike_through),
      code: on(marks.inlineCode),
      heading,
      bullets,
      numbers,
      checklist,
      quote,
    }
    const key = JSON.stringify(message)
    if (key === this.lastState) return
    this.lastState = key
    this.post(message)
  }
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks())
  let found = false
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false
    if (node.isText && node.marks.some((m: Mark) => m.type === type)) found = true
    return !found
  })
  return found
}
