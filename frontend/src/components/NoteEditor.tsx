/**
 * The note of a task, edited without visible marks (WYSIWYG) and kept as Markdown (data model, "Notiz (Markdown, seit
 * 07.11.2026)"). Milkdown (MIT) with the CommonMark preset and from GFM only strikethrough, task lists and autolinks:
 * no tables (a pasted table becomes plain lines), no block menu. Loaded only when a detail opens.
 *
 * A small bar above the field: bold, italic, strikethrough, heading, bullet list, numbered list, checklist, quote,
 * code, link, picture; the usual keys (Ctrl+B, Ctrl+I, …) and Markdown typed at the start of a line (`# `, `- `,
 * `[] `) do the same. A picture picked, pasted or dropped becomes an attachment of the task first, then
 * `![Name](attachment:<uuid>)` in the text; it shows inline, small, and larger on a click. Pictures from other
 * addresses are never loaded: they show as a link. Saved a moment after typing stops and when the field is left.
 */
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { history } from '@milkdown/kit/plugin/history'
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
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose, callCommand } from '@milkdown/kit/utils'
import { Bold, Code, Heading, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Quote, Strikethrough, X } from 'lucide-react'
import { createElement, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import '@milkdown/kit/prose/view/style/prosemirror.css'

import { useEngine, useView } from '../state/sync'
import { APP_BASE } from '../sync/transport'
import type { Reminder } from '../sync/types'
import { NOTES_MAX, NOTES_WARN, SAVE_AFTER_MS } from '../lib/notes'
import { noteSyntax, pictureView, taskTicks, toggleChecklist, type PictureHost } from '../lib/noteMilkdown'

/** Pictures by attachment id: the file just picked (shown at once), else fetched from the server once. */
const pictures = new Map<string, Promise<string | null>>()

function pictureOf(id: string): Promise<string | null> {
  let found = pictures.get(id)
  if (!found) {
    found = fetch(`${APP_BASE}/files/${id}`, { headers: { 'X-Nextasks-Client': 'web' }, credentials: 'same-origin' })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => null)
    pictures.set(id, found)
  }
  return found
}

/** Pictures pasted or dropped go up as attachments; with `upload` null (a task not made yet) they are refused. */
function picturePlugin(upload: () => ((files: File[], at?: number) => void) | null, refuse: () => void) {
  const take = (files: File[], at?: number) => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (!pics.length) return false
    const go = upload()
    if (go) go(pics, at)
    else refuse()
    return true
  }
  return $prose(
    () =>
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const files = [...(event.clipboardData?.files ?? [])]
            if (!take(files)) return false
            event.preventDefault()
            return true
          },
          handleDrop: (view, event) => {
            const files = [...(event.dataTransfer?.files ?? [])]
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            if (!take(files, at)) return false
            event.preventDefault()
            return true
          },
        },
      }),
  )
}

type Tool = { key: string; icon: ComponentType<{ className?: string }>; label: string; run: () => void }

export default function NoteEditor({ reminder, label, onSave, locked }: { reminder: Reminder; label: string; onSave: (notes: string) => void; locked?: string | null }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const files = useRef<HTMLInputElement>(null)
  const [length, setLength] = useState(reminder.notes.length)
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)

  // What the editor reads while it runs, always the newest.
  const live = useRef({ view, onSave, locked, reminder, t })
  live.current = { view, onSave, locked, reminder, t }
  const saved = useRef(reminder.notes)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const text = pending.current
    pending.current = null
    if (text === null || text === saved.current) return
    if (text.length > NOTES_MAX) {
      setHint(live.current.t('detail.notesTooLong', { max: NOTES_MAX.toLocaleString() }))
      return
    }
    saved.current = text
    live.current.onSave(text)
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const upload = (pics: File[], at?: number) => {
    const pm = editor.current?.ctx.get(editorViewCtx)
    if (!pm) return
    const limit = engine.me?.limits.attachment_bytes ?? 50 * 1024 * 1024
    for (const file of pics) {
      if (file.size > limit || !file.size) {
        setHint(live.current.t(file.size ? 'detail.tooLarge' : 'detail.emptyFile', { name: file.name, size: `${Math.round(limit / 1024 / 1024)} MB` }))
        continue
      }
      const name = file.name || 'Bild'
      void engine.attach(live.current.reminder.id, file, name).then((id) => {
        if (typeof URL.createObjectURL === 'function') pictures.set(id, Promise.resolve(URL.createObjectURL(file)))
        const node = pm.state.schema.nodes.image.create({ src: `attachment:${id}`, alt: name.replace(/\.[a-z0-9]+$/i, '') })
        const pos = at ?? pm.state.selection.from
        pm.dispatch(pm.state.tr.insert(Math.min(pos, pm.state.doc.content.size), node))
      })
    }
  }
  const uploadRef = useRef(upload)
  uploadRef.current = upload

  useEffect(() => {
    if (!root.current) return
    let gone = false
    const host = (): PictureHost => ({
      exists: (id) => live.current.view.attachmentsOf(live.current.reminder.id).some((a) => a.id.toLowerCase() === id),
      source: pictureOf,
      zoom: (url, name) => setZoom({ url, name }),
      words: { removed: live.current.t('detail.pictureRemoved'), picture: live.current.t('detail.picture'), open: live.current.t('detail.open') },
    })
    const made = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root.current!)
        ctx.set(defaultValueCtx, reminder.notes)
        ctx.update(editorViewOptionsCtx, (options) => ({ ...options, attributes: { class: 'nt-note-body', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', 'data-testid': 'notes' } }))
      })
      .use(noteSyntax)
      .use(history)
      .use(
        // Every change of the text, at once (the listener plugin would wait 200 ms more); leaving saves.
        $prose(
          (ctx) =>
            new Plugin({
              view: () => ({
                update: (pmView, before) => {
                  if (pmView.state.doc.eq(before.doc)) return
                  const markdown = ctx.get(serializerCtx)(pmView.state.doc)
                  // An empty note is an empty string, not a lone line break.
                  pending.current = markdown.trim() ? markdown : ''
                  setLength(pending.current.length)
                  if (timer.current) clearTimeout(timer.current)
                  timer.current = setTimeout(() => saveRef.current(), SAVE_AFTER_MS)
                },
              }),
              props: { handleDOMEvents: { blur: () => (saveRef.current(), false) } },
            }),
        ),
      )
      .use(clipboard)
      .use(taskTicks)
      .use(pictureView(host))
      .use(
        picturePlugin(
          () => (live.current.locked ? null : (pics, at) => uploadRef.current(pics, at)),
          () => setHint(live.current.locked ?? null),
        ),
      )
    void made.create().then(() => {
      if (gone) {
        void made.destroy()
        return
      }
      editor.current = made
      const pm = made.ctx.get(editorViewCtx)
      // The tests (and only they) reach the view through its element.
      Object.defineProperty(pm.dom, 'nextasksEditor', { value: pm, configurable: true })
    })
    return () => {
      gone = true
      saveRef.current()
      if (editor.current) void editor.current.destroy()
      editor.current = null
    }
    // The editor is made once per task; the newest props are read through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const call = <T,>(command: { key: unknown }, payload?: T) => {
    editor.current?.action(callCommand(command.key as never, payload as never))
    editor.current?.ctx.get(editorViewCtx).focus()
  }
  const pm = (): EditorView | undefined => editor.current?.ctx.get(editorViewCtx)
  const inHeading = () => pm()?.state.selection.$from.parent.type.name === 'heading'
  const checklist = () => {
    const v = pm()
    if (v) toggleChecklist(v, () => call(wrapInBulletListCommand))
  }

  const tools: Tool[] = [
    { key: 'bold', icon: Bold, label: t('notes.bold'), run: () => call(toggleStrongCommand) },
    { key: 'italic', icon: Italic, label: t('notes.italic'), run: () => call(toggleEmphasisCommand) },
    { key: 'strike', icon: Strikethrough, label: t('notes.strike'), run: () => call(toggleStrikethroughCommand) },
    { key: 'heading', icon: Heading, label: t('notes.heading'), run: () => (inHeading() ? call(turnIntoTextCommand) : call(wrapInHeadingCommand, 2)) },
    { key: 'bullets', icon: List, label: t('notes.bullets'), run: () => call(wrapInBulletListCommand) },
    { key: 'numbers', icon: ListOrdered, label: t('notes.numbers'), run: () => call(wrapInOrderedListCommand) },
    { key: 'checklist', icon: ListChecks, label: t('notes.checklist'), run: checklist },
    { key: 'quote', icon: Quote, label: t('notes.quote'), run: () => call(wrapInBlockquoteCommand) },
    { key: 'code', icon: Code, label: t('notes.code'), run: () => call(toggleInlineCodeCommand) },
    { key: 'link', icon: Link2, label: t('notes.link'), run: () => setLinking('https://') },
    {
      key: 'picture',
      icon: ImagePlus,
      label: t('notes.picture'),
      run: () => (locked ? setHint(locked) : files.current?.click()),
    },
  ]

  const keys: Record<string, string> = { bold: 'Ctrl+B', italic: 'Ctrl+I', strike: 'Ctrl+Alt+X', code: 'Ctrl+E' }
  return (
    <div className="nt-notes nt-note" data-testid="note-editor">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-ink-700 px-1.5 py-1" role="toolbar" aria-label={t('notes.tools')}>
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            data-tool={tool.key}
            aria-label={tool.label}
            title={keys[tool.key] ? `${tool.label} (${keys[tool.key]})` : tool.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={tool.run}
            className={'rounded-md p-1.5 text-mist-500 hover:bg-ink-800 hover:text-mist-100 ' + (tool.key === 'picture' && locked ? 'opacity-50' : '')}
          >
            {createElement(tool.icon, { className: 'h-4 w-4' })}
          </button>
        ))}
        <span className="ml-auto pr-1 text-[11px] text-mist-500" aria-live="polite">
          {length >= NOTES_WARN ? t('detail.notesLeft', { count: Math.max(0, NOTES_MAX - length) }) : ''}
        </span>
      </div>
      {linking !== null && (
        <form
          className="flex items-center gap-2 border-b border-ink-700 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const href = linking.trim()
            setLinking(null)
            if (href && /^(https?:|mailto:)/i.test(href)) call(toggleLinkCommand, { href })
          }}
        >
          <Link2 className="h-4 w-4 text-mist-500" aria-hidden />
          <input autoFocus value={linking} onChange={(e) => setLinking(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setLinking(null))} aria-label={t('notes.linkAddress')} className="min-w-0 flex-1 bg-transparent text-sm text-mist-100 focus:outline-none" />
          <button type="submit" className="nc-btn nc-btn-accent px-2.5 py-1 text-xs">
            {t('notes.linkSet')}
          </button>
        </form>
      )}
      <div ref={root} className="nt-note-root" style={{ '--note-placeholder': JSON.stringify(t('detail.notesPlaceholder')) } as CSSProperties} data-empty={length === 0 ? 'true' : undefined} />
      {hint && (
        <p role="status" className="flex items-start gap-2 border-t border-ink-700 px-3 py-1.5 text-xs text-warn-500">
          <span className="flex-1">{hint}</span>
          <button type="button" onClick={() => setHint(null)} aria-label={t('common.close')} className="text-mist-500 hover:text-mist-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
      <input
        ref={files}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label={t('notes.picture')}
        data-testid="note-picture"
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])]
          e.target.value = ''
          if (chosen.length) uploadRef.current(chosen)
        }}
      />
      {zoom && (
        <div className="nt-veil fixed inset-0 z-[80] grid place-items-center p-6" onPointerDown={() => setZoom(null)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setZoom(null))} role="dialog" aria-modal="true" aria-label={zoom.name || t('detail.picture')}>
          <img src={zoom.url} alt={zoom.name} className="max-h-[90vh] max-w-[92vw] rounded-xl shadow-2xl" />
        </div>
      )}
    </div>
  )
}
