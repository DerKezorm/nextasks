/**
 * The parts of the note editor that the web page and the iPhone app's editor share (data model, "Notiz (Markdown,
 * seit 07.11.2026)"): Milkdown with the CommonMark preset and from GFM only strikethrough, task lists and autolinks,
 * no tables; the checklist shortcut; ticking a box; pictures from attachments only.
 */
import { commonmark, imageSchema } from '@milkdown/kit/preset/commonmark'
import {
  autoInsertSpanPlugin,
  extendListItemSchemaForTask,
  remarkGFMPlugin,
  strikethroughAttr,
  strikethroughInputRule,
  strikethroughKeymap,
  strikethroughSchema,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin } from '@milkdown/kit/prose/state'
import { findWrapping } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $inputRule, $prose, $remark, $view } from '@milkdown/kit/utils'

export const ATTACHMENT = /^attachment:([0-9a-fA-F-]{36})$/

/** What the picture view asks of the page while the editor runs. */
export interface PictureHost {
  /** Whether the task still has this attachment (lower-case id). */
  exists: (id: string) => boolean
  /** Where the picture's bytes come from: an object URL in the web, `nextasks-file://<id>` in the app. */
  source: (id: string) => Promise<string | null>
  /** A picture was clicked or tapped. */
  zoom: (url: string, name: string, id: string) => void
  words: { removed: string; picture: string; open: string }
  /** Links of pictures from elsewhere: the web opens them in a tab, the app hands them to the system. */
  openLink?: (url: string) => void
}

/** Tables and footnotes are not part of a note: what remark-gfm reads as such becomes plain lines again. */
export const noTables = $remark('nextasksNoTables', () => () => (tree: unknown) => {
  type Mdast = { type: string; value?: string; children?: Mdast[]; identifier?: string }
  const text = (node: Mdast): string => (node.value ?? '') + (node.children ?? []).map(text).join('')
  const walk = (node: Mdast) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): Mdast[] => {
      if (child.type === 'table')
        return (child.children ?? []).map((row) => ({ type: 'paragraph', children: [{ type: 'text', value: (row.children ?? []).map(text).join(' | ') }] }))
      if (child.type === 'footnoteDefinition') return [{ type: 'paragraph', children: [{ type: 'text', value: `[^${child.identifier ?? ''}]: ${text(child)}` }] }]
      if (child.type === 'footnoteReference') return [{ type: 'text', value: `[^${child.identifier ?? ''}]` }]
      walk(child)
      return [child]
    })
  }
  walk(tree as Mdast)
})

/** A picture: an attachment shows small and opens larger; any other address only as a link, never loaded. */
export function pictureView(host: () => PictureHost) {
  return $view(imageSchema.node, () => (node: ProseNode) => {
    const src = String(node.attrs.src ?? '')
    const alt = String(node.attrs.alt ?? '')
    const own = ATTACHMENT.exec(src)
    const words = host().words
    if (!own) {
      const link = document.createElement('a')
      link.href = /^https?:\/\//i.test(src) ? src : '#'
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
      link.className = 'nt-note-extimg'
      link.dataset.foreignPicture = 'true'
      link.textContent = `${words.picture}: ${alt || src}`
      link.title = words.open
      const open = host().openLink
      if (open)
        link.addEventListener('click', (event) => {
          event.preventDefault()
          if (/^https?:\/\//i.test(src)) open(src)
        })
      return { dom: link, ignoreMutation: () => true }
    }
    const id = own[1].toLowerCase()
    const box = document.createElement('span')
    box.className = 'nt-note-img'
    box.contentEditable = 'false'
    if (!host().exists(id)) {
      box.textContent = words.removed
      box.dataset.removed = 'true'
      return { dom: box, ignoreMutation: () => true }
    }
    const img = document.createElement('img')
    img.alt = alt
    img.dataset.attachment = id
    img.draggable = false
    box.append(img)
    void host()
      .source(id)
      .then((url) => {
        if (url) img.src = url
        else box.textContent = words.removed
      })
    img.addEventListener('click', () => img.src && host().zoom(img.src, alt, id))
    return { dom: box, ignoreMutation: () => true }
  })
}

/**
 * `[] `, `[ ] ` or `[x] ` typed at the start of a line makes a checklist item: inside a list the item gets its box,
 * elsewhere the line becomes the first item of a new checklist. (GFM's own rule wants the space inside and a list.)
 */
export const checklistShortcut = $inputRule(
  () =>
    new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
      const checked = match[1].toLowerCase() === 'x'
      const $start = state.doc.resolve(start)
      for (let depth = $start.depth; depth > 0; depth--) {
        const node = $start.node(depth)
        if (node.type.name === 'list_item') {
          if (node.attrs.checked != null && !checked) return null
          return state.tr.delete(start, end).setNodeMarkup($start.before(depth), undefined, { ...node.attrs, checked })
        }
      }
      if ($start.parent.type.name !== 'paragraph') return null
      const tr = state.tr.delete(start, end)
      const range = tr.doc.resolve(start).blockRange()
      const list = state.schema.nodes.bullet_list
      const wrapping = range && findWrapping(range, list)
      if (!range || !wrapping) return null
      tr.wrap(range, wrapping)
      const item = tr.doc.resolve(range.start + 2)
      for (let depth = item.depth; depth > 0; depth--) {
        if (item.node(depth).type.name === 'list_item') {
          tr.setNodeMarkup(item.before(depth), undefined, { ...item.node(depth).attrs, checked })
          break
        }
      }
      return tr
    }),
)

/** A click (or tap) on the box of a checklist item ticks it or opens it again. */
export const taskTicks = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            const item = (event.target as HTMLElement).closest?.('li[data-item-type="task"]') as HTMLElement | null
            if (!item || event.offsetX > 26) return false
            const pos = view.posAtDOM(item, 0) - 1
            const node = view.state.doc.nodeAt(pos)
            if (!node || node.attrs.checked == null) return false
            event.preventDefault()
            view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }))
            return true
          },
        },
      },
    }),
)

/** The schema and rules of a note, without the page's own plugins. */
export const noteSyntax = [
  commonmark,
  [extendListItemSchemaForTask, strikethroughAttr, strikethroughSchema, toggleStrikethroughCommand, strikethroughKeymap, strikethroughInputRule, remarkGFMPlugin, autoInsertSpanPlugin].flat(),
  checklistShortcut,
  noTables,
].flat()

/** The checklist key: the line becomes (or stops being) a checklist item, a list made around it if need be. */
export function toggleChecklist(view: EditorView, wrapInList: () => void) {
  wrapInList()
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'list_item') {
      view.dispatch(view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: node.attrs.checked == null ? false : null }))
      return
    }
  }
}
