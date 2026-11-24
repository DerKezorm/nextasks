/**
 * "History" in the detail of a task of a shared space: its comments (who with picture, when, the text with its line
 * breaks, links and highlighted mentions, optionally a picture) and, between them in grey, what happened to the task
 * (made, done, date, assignees, priority, list, title; one person's changes of a field within ten minutes are one
 * line on the server). Below a field to write: Enter sends, Shift+Enter breaks the line, `@` offers the people of the
 * space. Own comments can be changed for a day and removed at any time; a manager of the space removes any.
 */
import { Check, ImagePlus, MessageCircle, MoreHorizontal, Pencil, SendHorizontal, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { COMMENT_MAX, loadHistory, mayEdit, mentionsIn, pieces, timeline, typedMention, type TaskEvent } from '../lib/comments'
import { ago, moment } from '../lib/time'
import { useEngine, useView } from '../state/sync'
import { APP_BASE } from '../sync/transport'
import type { Comment, Reminder } from '../sync/types'
import { uuid4 } from '../sync/uuid'
import { personName, PersonAvatar } from './People'
import { PictureViewer } from './PictureViewer'
import { useShell } from './Shell'

type Picked = { id: number; name: string }

/** A file of the server as an address the page can show (files need the web's header). */
function useFile(id: string | null, waiting: boolean): string | null {
  const [found, setFound] = useState<{ id: string; url: string } | null>(null)
  useEffect(() => {
    if (!id || waiting) return
    let alive = true
    let made: string | null = null
    void fetch(`${APP_BASE}/files/${id}`, { headers: { 'X-Nextasks-Client': 'web' }, credentials: 'same-origin' })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || !alive) return
        made = URL.createObjectURL(blob)
        setFound({ id, url: made })
      })
      .catch(() => undefined)
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [id, waiting])
  return found && found.id === id ? found.url : null
}

function Picture({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const url = useFile(id, engine.waiting('attachment', id))
  const [big, setBig] = useState(false)
  if (!url) return <span className="mt-1.5 block h-24 w-36 animate-pulse rounded-lg bg-ink-800" aria-label={t('comments.pictureLoading')} />
  return (
    <>
      <button type="button" className="mt-1.5 block overflow-hidden rounded-lg border border-ink-700" onClick={() => setBig(true)} aria-label={t('comments.pictureOpen')}>
        <img src={url} alt={name} className="max-h-48 max-w-full object-contain" />
      </button>
      {big && <PictureViewer url={url} name={name} onClose={() => setBig(false)} />}
    </>
  )
}

function Text({ comment, people }: { comment: Comment; people: Picked[] }) {
  const mentioned = people.filter((p) => comment.mentions.includes(p.id))
  return (
    <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-mist-100" data-testid="comment-text">
      {pieces(comment.text, mentioned).map((piece, index): ReactNode => {
        if (piece.kind === 'link')
          return (
            <a key={index} href={piece.text} target="_blank" rel="noreferrer noopener" className="text-accent-400 underline decoration-accent-500/40 hover:decoration-accent-400">
              {piece.text}
            </a>
          )
        if (piece.kind === 'mention')
          return (
            <span key={index} className="rounded bg-accent-wash px-0.5 font-semibold text-accent-400" data-testid="mention">
              {piece.text}
            </span>
          )
        return piece.text
      })}
    </p>
  )
}

/** The grey line of an event: who did what. */
function useEventLine(): (event: TaskEvent) => string {
  const { t, i18n } = useTranslation()
  const view = useView()
  // A day as it was, not as seen from today: "tomorrow" in a history would be wrong by tomorrow.
  const day = (date: string, time: string | null = null) => {
    const shown = new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' })
    return time ? `${shown}, ${time}` : shown
  }
  return (event) => {
    const name = personName(event.by ? view.people.get(event.by) : undefined, t)
    const value = event.new as Record<string, unknown> | number[] | number | string | boolean | null
    switch (event.field) {
      case 'created':
        return t('comments.event.created', { name })
      case 'completion':
        return t(value ? 'comments.event.completed' : 'comments.event.reopened', { name })
      case 'occurrence':
        return t('comments.event.occurrence', { name, date: day(String(value)) })
      case 'due': {
        const due = (value ?? {}) as { due_date?: string | null; due_time?: string | null }
        if (!due.due_date) return t('comments.event.dueRemoved', { name })
        return t('comments.event.due', { name, date: day(due.due_date, due.due_time ?? null) })
      }
      case 'assignees': {
        const ids = Array.isArray(value) ? value : []
        if (!ids.length) return t('comments.event.assigneesNone', { name })
        return t('comments.event.assignees', { name, people: ids.map((id) => personName(view.people.get(id), t)).join(', ') })
      }
      case 'priority':
        return t('comments.event.priority', { name, priority: t(`priority.${Number(value) || 0}`) })
      case 'list': {
        const target = (value ?? {}) as { name?: string | null }
        return target.name ? t('comments.event.moved', { name, list: target.name }) : t('comments.event.movedAway', { name })
      }
      case 'title':
        return t('comments.event.renamed', { name, title: String(value ?? '') })
      default:
        return t('comments.event.changed', { name })
    }
  }
}

function CommentItem({ comment, people, manager }: { comment: Comment; people: Picked[]; manager: boolean }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const me = view.me
  const author = comment.author_id ? view.people.get(comment.author_id) : undefined
  const removed = !!comment.removed_at
  const editable = mayEdit(comment, me, engine.now())
  const removable = !removed && (comment.author_id === me || manager)
  const waiting = engine.waiting('comment', comment.id)
  const save = () => {
    const text = (editing ?? '').trim()
    if (text && text !== comment.text) engine.put('comment', comment.id, { text, mentions: mentionsIn(text, people.filter((p) => comment.mentions.includes(p.id) || text.includes(`@${p.name}`))) })
    setEditing(null)
  }
  return (
    <li className="group/comment flex gap-2.5 py-2" data-testid="comment" data-comment={comment.id}>
      {comment.author_id ? <PersonAvatar id={comment.author_id} person={author} className="mt-0.5 h-7 w-7 text-xs" /> : <span className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-ink-800" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-semibold text-mist-100">{personName(author, t)}</span>
          <time dateTime={comment.created_at} title={moment(comment.created_at, i18n.language)} className="text-mist-500">
            {waiting ? t('comments.sending') : ago(Date.parse(comment.created_at), i18n.language)}
          </time>
          {comment.edited_at && !removed && <span className="text-mist-500">· {t('comments.edited')}</span>}
          {(editable || removable) && editing === null && (
            <span className="relative ml-auto">
              <button type="button" className="rounded-md p-0.5 text-mist-500 opacity-0 group-hover/comment:opacity-100 hover:text-mist-100 focus:opacity-100 aria-expanded:opacity-100" aria-label={t('comments.actions')} aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menu && (
                <span role="menu" className="absolute top-6 right-0 z-20 flex min-w-36 flex-col rounded-lg border border-ink-700 bg-ink-850 p-1 shadow-xl shadow-black/30" onMouseLeave={() => setMenu(false)}>
                  {editable && (
                    <button type="button" role="menuitem" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-mist-100 hover:bg-ink-800" onClick={() => (setMenu(false), setEditing(comment.text))}>
                      <Pencil className="h-3.5 w-3.5" /> {t('comments.edit')}
                    </button>
                  )}
                  {removable && (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-bad-500 hover:bg-ink-800"
                      onClick={() => {
                        setMenu(false)
                        shell.ask({ title: t('comments.removeTitle'), text: t('comments.removeText'), final: true, confirm: t('comments.remove'), run: () => engine.removeComment(comment.id) })
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> {t('comments.remove')}
                    </button>
                  )}
                </span>
              )}
            </span>
          )}
        </div>
        {removed ? (
          <p className="text-sm text-mist-500 italic" data-testid="comment-removed">
            {t('comments.removed')}
          </p>
        ) : editing !== null ? (
          <div className="mt-1 flex items-start gap-1.5">
            <textarea
              value={editing}
              autoFocus
              rows={Math.min(6, editing.split('\n').length)}
              aria-label={t('comments.edit')}
              maxLength={COMMENT_MAX}
              className="nt-field min-h-9 flex-1 resize-none py-1.5 text-sm"
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  save()
                } else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(null)
                }
              }}
            />
            <button type="button" className="nt-icon-btn" aria-label={t('comments.save')} onClick={save}>
              <Check className="h-4 w-4" />
            </button>
            <button type="button" className="nt-icon-btn" aria-label={t('common.cancel')} onClick={() => setEditing(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            {comment.text && <Text comment={comment} people={people} />}
            {comment.attachment_id && <Picture id={comment.attachment_id} name={t('comments.picture')} />}
          </>
        )}
      </div>
    </li>
  )
}

function Composer({ reminder, people }: { reminder: Reminder; people: Picked[] }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<Picked[]>([])
  const [picture, setPicture] = useState<File | null>(null)
  const [typing, setTyping] = useState<{ start: number; query: string } | null>(null)
  const [chosen, setChosen] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const limit = engine.me?.limits.attachment_bytes ?? 50 * 1024 * 1024
  const query = typing?.query.toLocaleLowerCase() ?? ''
  const offered = typing ? people.filter((p) => p.name.toLocaleLowerCase().split(/\s+/).some((part) => part.startsWith(query)) || p.name.toLocaleLowerCase().startsWith(query)).slice(0, 6) : []

  const look = (text: string, caret: number) => {
    setTyping(typedMention(text, caret))
    setChosen(0)
  }

  const take = (person: Picked) => {
    if (!typing) return
    const caret = field.current?.selectionStart ?? draft.length
    const text = `${draft.slice(0, typing.start)}@${person.name} ${draft.slice(caret)}`
    const at = typing.start + person.name.length + 2
    setDraft(text)
    setPicked((before) => [...before.filter((p) => p.id !== person.id), person])
    setTyping(null)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(at, at)
    })
  }

  const send = async () => {
    const text = draft.trim()
    if (!text && !picture) return
    if ([...text].length > COMMENT_MAX) return setProblem(t('comments.tooLong', { max: COMMENT_MAX }))
    const chosenPicture = picture
    setDraft('')
    setPicked([])
    setPicture(null)
    setProblem(null)
    let attachment: string | null = null
    if (chosenPicture) attachment = await engine.attach(reminder.id, chosenPicture, chosenPicture.name)
    engine.put('comment', uuid4(), { reminder_id: reminder.id, text, mentions: mentionsIn(text, picked), attachment_id: attachment })
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (offered.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setChosen((chosen + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        take(offered[chosen] ?? offered[0])
        return
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        setTyping(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="relative mt-2">
      {offered.length > 0 && (
        <ul role="listbox" aria-label={t('comments.mentionList')} data-testid="mention-list" className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-lg border border-ink-700 bg-ink-850 p-1 shadow-xl shadow-black/30">
          {offered.map((person, index) => (
            <li key={person.id} role="option" aria-selected={index === chosen}>
              <button
                type="button"
                className={'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ' + (index === chosen ? 'bg-accent-wash text-accent-400' : 'text-mist-100 hover:bg-ink-800')}
                onMouseDown={(e) => {
                  e.preventDefault()
                  take(person)
                }}
              >
                <PersonAvatar id={person.id} person={{ id: person.id, name: person.name, avatar_hash: null }} className="h-5 w-5 text-[10px]" />
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picture && (
        <p className="mb-1.5 flex items-center gap-2 text-xs text-mist-400" data-testid="comment-picture">
          <ImagePlus className="h-3.5 w-3.5" aria-hidden /> <span className="min-w-0 truncate">{picture.name}</span>
          <button type="button" className="rounded p-0.5 hover:text-mist-100" aria-label={t('comments.pictureRemove')} onClick={() => setPicture(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
      <div className="flex items-end gap-1.5 rounded-xl border border-ink-700 bg-ink-900 px-2 py-1.5 focus-within:border-accent-500">
        <textarea
          ref={field}
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          placeholder={t('comments.placeholder')}
          aria-label={t('comments.placeholder')}
          data-testid="comment-field"
          maxLength={COMMENT_MAX}
          className="max-h-40 min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-mist-100 placeholder:text-mist-500 focus:outline-none"
          onChange={(e) => {
            setDraft(e.target.value)
            look(e.target.value, e.target.selectionStart)
          }}
          onSelect={(e) => look(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTyping(null)}
          onKeyDown={onKey}
        />
        <button type="button" className="nt-icon-btn shrink-0" aria-label={t('comments.pictureAdd')} title={t('comments.pictureAdd')} onClick={() => files.current?.click()}>
          <ImagePlus className="h-4 w-4" />
        </button>
        <button type="button" className="nt-icon-btn shrink-0 text-accent-400 disabled:opacity-40" aria-label={t('comments.send')} title={t('comments.send')} disabled={!draft.trim() && !picture} onClick={() => void send()}>
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1 px-1 text-[11px] text-mist-500">{t('comments.keys')}</p>
      {problem && (
        <p role="alert" className="nt-problem mt-1">
          {problem}
        </p>
      )}
      <input
        ref={files}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={t('comments.pictureAdd')}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null
          e.target.value = ''
          if (!file) return
          if (file.size > limit || file.size === 0) return setProblem(t('comments.pictureTooLarge'))
          setProblem(null)
          setPicture(file)
        }}
      />
    </div>
  )
}

/** The history of a task with its comments; only for a task of a shared space (the caller decides). */
export function CommentsSection({ reminder, spaceId }: { reminder: Reminder; spaceId: string }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const line = useEventLine()
  const [history, setHistory] = useState<{ id: string; events: TaskEvent[] } | null>(null)
  const cursor = engine.cursor
  useEffect(() => {
    let alive = true
    loadHistory(reminder.id)
      .then((events) => alive && setHistory({ id: reminder.id, events }))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [reminder.id, cursor])
  const members = view.membersOf(spaceId)
  const manager = members.some((m) => m.account_id === view.me && m.role === 'manager')
  const people: Picked[] = members
    .filter((m) => m.account_id !== view.me)
    .map((m) => ({ id: m.account_id, name: view.people.get(m.account_id)?.name ?? '' }))
    .filter((p) => p.name)
  const everybody: Picked[] = [...people, { id: view.me, name: view.people.get(view.me)?.name ?? '' }]
  const comments = view.commentsOf(reminder.id)
  const events = history?.id === reminder.id ? history.events : []
  const entries = timeline(comments, events)
  return (
    <section className="mt-5" aria-label={t('comments.title')} data-testid="comments">
      <h3 className="nt-sec mb-1.5 flex items-center gap-2 px-1">
        <MessageCircle className="h-4 w-4" aria-hidden data-field-icon /> {t('comments.title')}
        {comments.length > 0 && <span className="ml-auto tabular-nums">{t('comments.count', { count: view.commentCount(reminder.id) })}</span>}
      </h3>
      {entries.length === 0 ? (
        <p className="px-1 py-2 text-sm text-mist-500">{t('comments.empty')}</p>
      ) : (
        <ol className="px-1" data-testid="history">
          {entries.map((entry) =>
            entry.type === 'comment' ? (
              <CommentItem key={`c:${entry.comment.id}`} comment={entry.comment} people={everybody} manager={manager} />
            ) : (
              <li key={`e:${entry.event.id}`} className="flex items-center gap-2 py-1 pl-2.5 text-xs text-mist-500" data-testid="history-event">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-600" aria-hidden />
                <span className="min-w-0">
                  {line(entry.event)}
                  <time dateTime={entry.event.at} title={moment(entry.event.at, i18n.language)} className="ml-1.5 text-mist-600">
                    · {ago(Date.parse(entry.event.at), i18n.language)}
                  </time>
                </span>
              </li>
            ),
          )}
        </ol>
      )}
      <Composer key={reminder.id} reminder={reminder} people={people} />
    </section>
  )
}
