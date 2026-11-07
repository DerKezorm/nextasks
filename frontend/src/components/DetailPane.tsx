/**
 * Everything of one task, as a card in the middle over the softly blurred page (a sheet from below on a phone), or
 * as `mode="pane"` in the column right of the page. A wide card splits in two: title, notes and subtasks on the left,
 * the fields on the right (due date with time, repetition, place, priority, assignees, list and section, tags, link,
 * files), each a row with a grey symbol and its name. The bookmark marks it. Text is saved when the field is left;
 * everything else at once. Escape, the ground around the card or the cross close it; the focus stays inside and goes
 * back to the row afterwards. Up and down (or j and k) leaf through the tasks of the page.
 *
 * With `draft` it shows a task that does not exist yet ("+ New task"): nothing is made until it has a title.
 */
import { Bookmark, CalendarDays, ChevronsUp, Clock, Download, FolderInput, Hash, Link2, ListTree, MapPin, Paperclip, Repeat, Trash2, Users, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { createReminder, moveReminder, siblingsAt, type Spot } from '../lib/actions'
import { describeRule, localDay } from '../lib/due'
import { picturedIn } from '../lib/notes'
import { moment } from '../lib/time'
import { useEngine, useView } from '../state/sync'
import { cleanTags } from '../sync/fields'
import { APP_BASE } from '../sync/transport'
import type { Attachment, Data, Reminder } from '../sync/types'
import { Badge } from './Badge'
import { NotesField } from './NotesField'
import { personName, PersonAvatar } from './People'
import { RepeatDialog } from './RepeatDialog'
import { useShell } from './Shell'
import { TickBox } from './TaskParts'

/** What a task that is not made yet does instead of writing (see `NewTaskDetail`). */
export interface Draft {
  put: (fields: Data) => void
  move: (spot: Spot) => void
  /** The title as it is being typed, so closing can still keep it. */
  typing: (title: string) => void
}

/** One field: grey symbol and name on the left, the value on the right; what needs room goes below. */
function Row({ icon: Icon, label, value, children }: { icon: LucideIcon; label: string; value?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-t border-ink-700 py-2.5 first:border-t-0">
      <div className="flex min-h-7 items-center gap-2.5">
        <Icon className="h-[18px] w-[18px] shrink-0 text-mist-500" aria-hidden data-field-icon />
        <span className="shrink-0 text-sm text-mist-100">{label}</span>
        <div className="flex min-w-0 flex-1 justify-end text-right text-sm text-mist-500">{value}</div>
      </div>
      {children && <div className="mt-1.5 pl-7">{children}</div>}
    </div>
  )
}

/** A text that is saved when it is left (or with Enter where it is one line). */
function TextField({ value, onSave, onDraft, label, placeholder, className = '', type = 'text', autoFocus = false }: { value: string; onSave: (v: string) => void; onDraft?: (v: string) => void; label: string; placeholder?: string; className?: string; type?: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value)
  const [was, setWas] = useState(value)
  if (value !== was) {
    setWas(value)
    setDraft(value)
  }
  return (
    <input
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onBlur={() => draft !== value && onSave(draft)}
      className={'w-full rounded-lg bg-transparent px-2 py-1 text-mist-100 placeholder:text-mist-500 hover:bg-ink-800 focus:bg-ink-800 focus:ring-1 focus:ring-accent-500 focus:outline-none ' + className}
      type={type}
      onChange={(e) => {
        setDraft(e.target.value)
        onDraft?.(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape' && draft !== value) {
          setDraft(value)
          onDraft?.(value)
          e.stopPropagation()
        }
      }}
    />
  )
}

/** Fields and buttons the focus may go to, in order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')].filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !(el as HTMLInputElement).hidden && el.getAttribute('type') !== 'file')
}

const typingIn = (el: EventTarget) => {
  const tag = (el as HTMLElement).tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(el as HTMLElement).closest?.('[contenteditable="true"]')
}

async function download(attachment: Attachment): Promise<void> {
  const response = await fetch(`${APP_BASE}/files/${attachment.id}`, { headers: { 'X-Nextasks-Client': 'web' }, credentials: 'same-origin' })
  if (!response.ok) return
  const url = URL.createObjectURL(await response.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = attachment.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function size(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function DetailPane({ reminder, mode = 'popup', draft }: { reminder: Reminder; mode?: 'popup' | 'pane'; draft?: Draft }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [repeating, setRepeating] = useState(false)
  const [tag, setTag] = useState('')
  const [subtask, setSubtask] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const files = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLElement>(null)
  const list = view.list(reminder.list_id)
  const space = list ? view.space(list.space_id) : undefined
  const put = (fields: Data) => (draft ? draft.put(fields) : engine.put('reminder', reminder.id, fields))
  const move = (spot: Spot) => (draft ? draft.move(spot) : moveReminder(engine, view, reminder.id, spot, siblingsAt(view, spot, reminder.id).length))
  const children = draft ? [] : view.childrenOf(reminder.id).filter((c) => !view.inTrash(c))
  const pictured = picturedIn(reminder.notes)
  const attachments = draft ? [] : view.attachmentsOf(reminder.id).filter((a) => !pictured.has(a.id.toLowerCase()))
  const members = space && !space.private ? view.membersOf(space.id) : []
  const limit = engine.me?.limits.attachment_bytes ?? 50 * 1024 * 1024
  const popup = mode === 'popup'
  const close = popup ? shell.closeReminder : shell.closePane

  const setDue = (date: string | null, time: string | null) => put({ due_date: date, due_time: date ? time : null, repeat: date ? reminder.repeat : null, repeat_from: date ? reminder.repeat_from : 'due' })

  // The card takes the focus when it opens (a new task: its title does), and the page behind it does not scroll.
  useEffect(() => {
    if (!popup) return
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true })
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = before
    }
  }, [popup])

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (repeating) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    } else if (!popup) {
      return
    } else if (e.key === 'Tab' && panel.current) {
      // The focus goes round inside the card.
      const all = focusables(panel.current)
      if (!all.length) return
      const first = all[0]
      const last = all[all.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    } else if (!draft && !typingIn(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
      // Leaf through the tasks of the page, in the order they are shown.
      const ids = [...document.querySelectorAll<HTMLElement>('main [data-reminder]')].map((row) => row.dataset.reminder!)
      const next = ids[ids.indexOf(reminder.id) + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)]
      e.preventDefault()
      if (next) shell.showPopup(next)
    }
  }

  const subtasks = !reminder.parent_id && !draft && (
    <section className="mt-4" aria-label={t('detail.subtasks')}>
      <h3 className="nt-sec mb-1.5 flex items-center gap-2 px-1">
        <ListTree className="h-4 w-4" aria-hidden data-field-icon /> {t('detail.subtasks')}
        {children.length > 0 && <span className="ml-auto tabular-nums">{t('detail.subtasksDone', { done: children.filter((c) => c.completed_at).length, count: children.length })}</span>}
      </h3>
      <div className="nt-card overflow-hidden">
        <ul data-testid="subtasks" className="divide-y divide-ink-700">
          {children.map((child) => (
            <li key={child.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
              <TickBox done={!!child.completed_at} title={child.title} onToggle={() => engine.toggle(child.id)} small />
              <button type="button" className={'min-w-0 flex-1 truncate text-left ' + (child.completed_at ? 'text-mist-500 line-through' : 'text-mist-100')} onClick={() => shell.openReminder(child.id)}>
                {child.title}
              </button>
            </li>
          ))}
        </ul>
        <form
          className={children.length ? 'border-t border-ink-700' : ''}
          onSubmit={(e) => {
            e.preventDefault()
            if (!subtask.trim()) return
            createReminder(engine, view, { list_id: reminder.list_id, section_id: null, parent_id: reminder.id }, { title: subtask })
            setSubtask('')
          }}
        >
          <input value={subtask} onChange={(e) => setSubtask(e.target.value)} placeholder={t('detail.addSubtask')} aria-label={t('detail.addSubtask')} className="w-full bg-transparent px-3 py-2 text-sm text-mist-100 placeholder:text-mist-500 focus:outline-none" />
        </form>
      </div>
    </section>
  )

  const card = (
    <aside
      ref={panel}
      role={popup ? 'dialog' : undefined}
      aria-modal={popup ? 'true' : undefined}
      aria-label={t(draft ? 'detail.newLabel' : 'detail.label')}
      data-testid={popup ? 'detail' : 'detail-pane'}
      data-draft={draft ? 'true' : undefined}
      tabIndex={popup ? -1 : undefined}
      className={
        '@container ' +
        (popup
          ? 'nt-pop nc-scroll flex max-h-[90dvh] w-full flex-col overflow-y-auto overscroll-contain rounded-t-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/40 outline-none sm:max-h-[88vh] sm:w-[min(960px,92vw)] sm:rounded-2xl'
          : 'nc-scroll hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l border-ink-700 bg-ink-900 lg:flex')
      }
      onKeyDown={onKey}
    >
      <div className="sticky top-0 z-10 bg-ink-900/95 px-5 pt-2 pb-2 backdrop-blur sm:pt-4">
        {popup && <span className="mx-auto mb-2 block h-1 w-10 rounded-full bg-ink-600 sm:hidden" aria-hidden />}
        <div className="flex items-center gap-2">
          {list && <Badge color={list.color} icon={list.icon} size="xs" />}
          <span className="min-w-0 flex-1 truncate text-[13px] text-mist-500">
            {space?.name} · {list?.name}
          </span>
          <button type="button" onClick={() => put({ flagged: !reminder.flagged })} aria-pressed={reminder.flagged} aria-label={t('detail.flag')} title={t('detail.flag')} className={'rounded-lg p-1.5 ' + (reminder.flagged ? 'text-petrol' : 'text-mist-500 hover:bg-ink-800 hover:text-mist-100')}>
            <Bookmark className={'h-4 w-4 ' + (reminder.flagged ? 'fill-current' : '')} />
          </button>
          {!draft && (
            <button
              type="button"
              onClick={() => {
                engine.trash('reminder', reminder.id)
                close()
              }}
              aria-label={t('detail.delete')}
              title={t('detail.delete')}
              className="rounded-lg p-1.5 text-mist-500 hover:bg-bad-500/10 hover:text-bad-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={close} aria-label={t('common.close')} className="rounded-lg p-1.5 text-mist-500 hover:bg-ink-800 hover:text-mist-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-5 pb-2 @min-[860px]:grid @min-[860px]:grid-cols-[minmax(0,1fr)_300px] @min-[860px]:gap-7" data-testid="detail-columns">
        <div data-part="main" className="min-w-0 pt-1 pb-3">
          <div className="flex items-start gap-1.5">
            <TickBox done={!!reminder.completed_at} title={reminder.title || t('detail.title')} onToggle={() => !draft && engine.toggle(reminder.id)} className={'mt-1.5 ' + (draft ? 'pointer-events-none opacity-40' : '')} />
            <div className="min-w-0 flex-1">
              <TextField
                value={reminder.title}
                label={t('detail.title')}
                placeholder={draft ? t('detail.titlePlaceholder') : undefined}
                autoFocus={!!draft}
                onDraft={draft?.typing}
                onSave={(title) => title.trim() && put({ title })}
                className={'text-[19px] font-bold ' + (reminder.completed_at ? 'text-mist-500 line-through' : '')}
              />
            </div>
          </div>
          <div className="mt-2 pl-7">
            <NotesField key={reminder.id} reminder={reminder} label={t('detail.notes')} onSave={(notes) => put({ notes })} locked={draft ? t('detail.notesNeedTitle') : null} />
          </div>
          <div className="pl-7">{subtasks}</div>
        </div>

        <div data-part="fields" className="min-w-0 border-ink-700 pb-3 @min-[860px]:border-l @min-[860px]:pl-6">
          <Row icon={CalendarDays} label={t('detail.due')}>
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" value={reminder.due_date ?? ''} onChange={(e) => setDue(e.target.value || null, reminder.due_time)} aria-label={t('detail.date')} className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-sm text-mist-100" />
              {reminder.due_date ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-4 w-4 text-mist-500" aria-hidden />
                    <input type="time" value={reminder.due_time ?? ''} onChange={(e) => setDue(reminder.due_date, e.target.value || null)} aria-label={t('detail.time')} className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-sm text-mist-100" />
                  </span>
                  <button type="button" className="text-xs text-mist-500 hover:text-mist-100" onClick={() => setDue(null, null)}>
                    {t('detail.noDate')}
                  </button>
                </>
              ) : (
                <button type="button" className="text-xs font-medium text-accent-400 hover:underline" onClick={() => setDue(localDay(), null)}>
                  {t('detail.today')}
                </button>
              )}
            </div>
          </Row>

          <Row
            icon={Repeat}
            label={t('detail.repeat')}
            value={
              <button type="button" className="truncate text-right hover:text-accent-400" onClick={() => setRepeating(true)} data-testid="repeat-open">
                {describeRule(reminder.repeat, reminder.repeat_from, i18n.language, t) ?? t('repeat.never')}
              </button>
            }
          />

          {reminder.location && (
            <Row
              icon={MapPin}
              label={t('detail.place')}
              value={
                <button type="button" className="text-xs text-bad-500 hover:underline" onClick={() => put({ location: null })}>
                  {t('detail.removePlace')}
                </button>
              }
            >
              <p className="text-sm text-mist-200">{t(reminder.location.on === 'arrive' ? 'detail.arrive' : 'detail.leave', { name: reminder.location.name })}</p>
              <p className="mt-0.5 text-xs text-mist-500">{t('detail.placeHint')}</p>
            </Row>
          )}

          <Row icon={ChevronsUp} label={t('detail.priority')}>
            <div className="flex rounded-[9px] bg-ink-800 p-0.5" role="radiogroup" aria-label={t('detail.priority')}>
              {[0, 1, 2, 3].map((p) => {
                const on = reminder.priority === p
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => put({ priority: p })}
                    className={'flex-1 rounded-[7px] px-1.5 py-1 text-xs font-medium ' + (on ? (p ? 'font-bold text-white' : 'bg-ink-850 text-mist-100 shadow-sm') : 'text-mist-500 hover:text-mist-100')}
                    style={on && p ? { background: `var(--color-prio-${p})` } : undefined}
                  >
                    {t(`priority.${p}`)}
                  </button>
                )
              })}
            </div>
          </Row>

          {members.length > 0 && (
            <Row icon={Users} label={t('detail.assignees')}>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('detail.assignees')}>
                {members.map((m) => {
                  const on = reminder.assignees.includes(m.account_id)
                  const person = view.people.get(m.account_id)
                  return (
                    <button
                      key={m.account_id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => put({ assignees: on ? reminder.assignees.filter((id) => id !== m.account_id) : [...reminder.assignees, m.account_id] })}
                      className={'flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs ' + (on ? 'border-accent-500 bg-chosen font-semibold text-accent-400' : 'border-ink-700 text-mist-400 hover:bg-ink-800')}
                    >
                      <PersonAvatar id={m.account_id} person={person} className="h-5 w-5 text-[10px]" />
                      {personName(person, t)}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-xs text-mist-500">{t('detail.assigneesHint')}</p>
            </Row>
          )}

          <Row icon={FolderInput} label={t('detail.where')}>
            <div className="flex flex-wrap gap-2">
              <select aria-label={t('detail.list')} className="max-w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-sm text-mist-100" value={reminder.list_id} onChange={(e) => move({ list_id: e.target.value, section_id: null, parent_id: null })}>
                {view.spaces.filter((s) => !view.isHidden(s.id) || s.id === view.list(reminder.list_id)?.space_id).map((s) => (
                  <optgroup key={s.id} label={s.name}>
                    {view.listsOf(s.id).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {!reminder.parent_id && view.sectionsOf(reminder.list_id).length > 0 && (
                <select
                  aria-label={t('detail.section')}
                  className="max-w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-sm text-mist-100"
                  value={reminder.section_id ?? ''}
                  onChange={(e) => move({ list_id: reminder.list_id, section_id: e.target.value || null, parent_id: null })}
                >
                  <option value="">{t('list.noSection')}</option>
                  {view.sectionsOf(reminder.list_id).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Row>

          <Row icon={Hash} label={t('detail.tags')}>
            <div className="flex flex-wrap items-center gap-1.5">
              {reminder.tags.map((name) => (
                <span key={name} className="nt-chip border-accent-500/40 text-accent-400">
                  #{name}
                  <button type="button" aria-label={t('detail.removeTag', { tag: name })} onClick={() => put({ tags: reminder.tags.filter((x) => x !== name) })} className="hover:text-mist-100">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const added = cleanTags([...reminder.tags, ...tag.split(/\s+/)])
                  if (added.length !== reminder.tags.length) put({ tags: added })
                  setTag('')
                }}
              >
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t('detail.addTag')} aria-label={t('detail.addTag')} className="w-28 rounded-md border border-ink-700 bg-transparent px-2 py-0.5 text-xs text-mist-100 placeholder:text-mist-500 focus:border-accent-500 focus:outline-none" />
              </form>
            </div>
          </Row>

          <Row
            icon={Link2}
            label={t('detail.url')}
            value={
              reminder.url && (
                <a href={reminder.url} target="_blank" rel="noreferrer noopener" className="text-xs font-medium text-accent-400 hover:underline">
                  {t('detail.open')}
                </a>
              )
            }
          >
            <TextField
              value={reminder.url ?? ''}
              type="url"
              label={t('detail.url')}
              placeholder="https://"
              onSave={(url) => {
                const value = url.trim()
                if (value && !/^(https?:|mailto:)/i.test(value)) return setProblem(t('detail.urlBad'))
                setProblem(null)
                put({ url: value || null })
              }}
              className="-ml-2 text-sm"
            />
          </Row>

          <Row
            icon={Paperclip}
            label={t('detail.files')}
            value={
              draft ? (
                <span className="text-xs">{t('detail.filesNeedTitle')}</span>
              ) : (
                <button type="button" className="text-xs font-medium text-accent-400 hover:underline" onClick={() => files.current?.click()}>
                  {t('detail.addFile')}
                </button>
              )
            }
          >
            {attachments.length > 0 && (
              <ul className="space-y-1" data-testid="attachments">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-mist-200">{a.name}</span>
                    <span className="text-xs text-mist-500">{size(a.size)}</span>
                    {engine.waiting('attachment', a.id) ? (
                      <span className="text-xs text-mist-500">{t('detail.uploading')}</span>
                    ) : (
                      <button type="button" aria-label={t('detail.download', { name: a.name })} className="rounded-md p-1 text-mist-400 hover:text-mist-100" onClick={() => void download(a)}>
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" aria-label={t('detail.removeFile', { name: a.name })} className="rounded-md p-1 text-mist-500 hover:text-bad-500" onClick={() => engine.remove('attachment', a.id)}>
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <input
            ref={files}
            type="file"
            multiple
            className="hidden"
            aria-label={t('detail.addFile')}
            onChange={(e) => {
              const chosen = [...(e.target.files ?? [])]
              e.target.value = ''
              const big = chosen.filter((f) => f.size > limit)
              setProblem(big.length ? t('detail.tooLarge', { name: big[0].name, size: size(limit) }) : chosen.some((f) => f.size === 0) ? t('detail.emptyFile') : null)
              for (const file of chosen) if (file.size > 0 && file.size <= limit) void engine.attach(reminder.id, file, file.name)
            }}
          />
        </div>
      </div>

      {problem && (
        <p role="alert" className="mx-5 mb-2 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
          {problem}
        </p>
      )}

      {!draft && (
        <p className="mx-5 border-t border-ink-700 py-4 text-xs text-mist-500">
          {t('detail.created', { name: personName(reminder.created_by ? view.people.get(reminder.created_by) : undefined, t), when: reminder.created_at ? moment(reminder.created_at, i18n.language) : '' })}
          {reminder.completed_at && (
            <>
              <br />
              {t('detail.completed', { name: personName(reminder.completed_by ? view.people.get(reminder.completed_by) : undefined, t), when: moment(reminder.completed_at, i18n.language) })}
            </>
          )}
        </p>
      )}

      {repeating && (
        <RepeatDialog
          value={{ repeat: reminder.repeat, repeat_from: reminder.repeat_from }}
          due={reminder.due_date ?? localDay()}
          onClose={() => setRepeating(false)}
          onSave={(value) => put({ due_date: reminder.due_date ?? localDay(), due_time: reminder.due_time, ...value })}
        />
      )}
    </aside>
  )
  if (!popup) return card
  return (
    <div className="nt-veil fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6" onPointerDown={(e) => e.target === e.currentTarget && close()} data-testid="detail-veil">
      {card}
    </div>
  )
}

/** Where "+ New task" puts its task, and what it starts with. */
export interface NewTarget {
  spot: Spot
  defaults: Data
}

/**
 * "+ New task": an empty task in the detail, the focus in its title. It is made once it has a title (leaving the
 * title, or another field set after a title was typed, or closing with a title typed); closed without one, nothing
 * is left. Afterwards the same detail goes on with the task that was made.
 */
export function NewTaskDetail({ target, mode }: { target: NewTarget; mode: 'popup' | 'pane' }) {
  const engine = useEngine()
  const view = useView()
  const [spot, setSpot] = useState<Spot>(target.spot)
  const [fields, setFields] = useState<Data>(target.defaults)
  const [made, setMade] = useState<string | null>(null)
  const typed = useRef('')
  const state = useRef({ spot, fields, made })
  state.current = { spot, fields, made }

  const make = (all: Data): string => {
    const id = createReminder(engine, view, state.current.spot, all)
    state.current.made = id
    setMade(id)
    return id
  }

  // Closed with a title typed but not yet left: it is kept all the same.
  useEffect(
    () => () => {
      const { made: done, fields: now } = state.current
      if (!done && typed.current.trim()) make({ ...now, title: typed.current.trim() })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const real = made ? view.reminder(made) : undefined
  if (made && real) return <DetailPane reminder={real} mode={mode} />

  const draft: Draft = {
    put: (change) => {
      // Made meanwhile (a field saved after the title): it goes to the task itself.
      if (state.current.made) return engine.put('reminder', state.current.made, change)
      const all = { ...fields, ...change }
      const title = String(all.title ?? typed.current).trim()
      if (title) make({ ...all, title })
      else setFields(all)
    },
    move: (to) => {
      setSpot(to)
      state.current.spot = to
      if (typed.current.trim()) make({ ...fields, title: typed.current.trim() })
    },
    typing: (title) => {
      typed.current = title
    },
  }
  const shown: Reminder = {
    id: 'new',
    list_id: spot.list_id,
    section_id: spot.section_id,
    parent_id: null,
    position: '',
    title: '',
    notes: '',
    url: null,
    due_date: null,
    due_time: null,
    repeat: null,
    repeat_from: 'due',
    location: null,
    flagged: false,
    priority: 0,
    tags: [],
    assignees: [],
    completed_at: null,
    completed_by: null,
    created_by: null,
    created_at: '',
    deleted_at: null,
    ...(fields as Partial<Reminder>),
  }
  return <DetailPane reminder={shown} mode={mode} draft={draft} />
}
