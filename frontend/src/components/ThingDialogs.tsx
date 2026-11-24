/**
 * Making and changing spaces and lists: name, colour, symbol; a list also chooses its space. Deleting asks first and
 * puts them into the trash (a space only by its managers, "Private" never).
 */
import { createElement, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { createList, createSpace, moveList } from '../lib/actions'
import { localDay } from '../lib/due'
import { colorOf, iconFor } from '../lib/look'
import { useSomedayLists } from '../lib/someday'
import { copyList, fillList, TEMPLATE_KINDS, TEMPLATES, type TemplateKind } from '../lib/templates'
import { keyAtEnd } from '../sync/position'
import { useEngine, useView } from '../state/sync'
import { textLength } from '../sync/fields'
import { Dialog } from './Dialog'
import { Mark } from './Mark'
import { askTrashList, askTrashSpace } from './Menus'
import { useShell } from './Shell'
import { ColorField, SymbolPicker } from './SymbolPicker'

/** Colour and symbol, as nexnotes' `LookFields`: the colours in a grid, the symbols with their search. */
export function LookPicker({ color, icon, onColor, onIcon }: { color: string; icon: string; onColor: (c: string) => void; onIcon: (i: string) => void }) {
  return (
    <>
      <ColorField value={color} onChange={onColor} />
      <SymbolPicker value={icon} onChange={onIcon} color={colorOf(color)} />
    </>
  )
}

/** The name with the look in front of it, as nexnotes' new folder: the symbol in its colour in a framed square. */
export function NameField({ value, onChange, label, color, icon }: { value: string; onChange: (v: string) => void; label: string; color: string; icon: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-mist-100">{label}</span>
      <span className="mt-1 flex items-center gap-2.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] border border-ink-700" data-testid="look-preview">
          <Mark color={color} icon={icon} size={20} />
        </span>
        <input className="nt-field" value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} autoFocus />
      </span>
    </label>
  )
}

export function SpaceDialog({ spaceId, onClose }: { spaceId: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const space = spaceId ? view.space(spaceId) : undefined
  const [name, setName] = useState(space?.name ?? '')
  const [color, setColor] = useState(space?.color ?? 'blue')
  const [icon, setIcon] = useState(space?.icon ?? 'people')
  const shell = useShell()
  const valid = textLength(name.trim()) >= 1 && textLength(name.trim()) <= 80
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    if (space) {
      const change: Record<string, string> = {}
      if (name.trim() !== space.name) change.name = name
      if (color !== space.color) change.color = color
      if (icon !== space.icon) change.icon = icon
      if (Object.keys(change).length) engine.put('space', space.id, change)
    } else createSpace(engine, view, name, color, icon)
    onClose()
  }
  return (
    <Dialog title={space ? t('space.editTitle') : t('space.newTitle')} onClose={onClose} medium>
      <form className="space-y-4" onSubmit={submit}>
        <NameField value={name} onChange={setName} label={t('space.name')} color={color} icon={icon} />
        <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
        {!space && <p className="text-xs text-mist-500">{t('space.newHint')}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {space && !space.private && space.role === 'manager' && (
            <button
              type="button"
              className="nt-btn nt-btn-quiet mr-auto text-bad-500"
              onClick={() => {
                onClose()
                shell.ask(
                  askTrashSpace(space, t, () => {
                    engine.trash('space', space.id)
                    navigate('/today')
                  }),
                )
              }}
            >
              {t('space.deleteAsk')}
            </button>
          )}
          <button type="button" className="nt-btn nt-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nt-btn nt-btn-accent" disabled={!valid}>
            {space ? t('common.save') : t('space.create')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function ListDialog({ listId, spaceId, onClose }: { listId: string | null; spaceId?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const list = listId ? view.list(listId) : undefined
  const [name, setName] = useState(list?.name ?? '')
  const [color, setColor] = useState(list?.color ?? 'blue')
  const [icon, setIcon] = useState(list?.icon ?? 'list')
  const [space, setSpace] = useState(list?.space_id ?? spaceId ?? view.defaultList?.space_id ?? view.shownSpaces[0]?.id ?? '')
  const [kind, setKind] = useState<TemplateKind>('empty')
  const [, leaveOut] = useSomedayLists()
  const shell = useShell()
  const valid = textLength(name.trim()) >= 1 && textLength(name.trim()) <= 80 && !!space
  // A template gives its name and look, unless one wrote a name of one's own.
  const choose = (next: TemplateKind) => {
    const named = TEMPLATE_KINDS.some((k) => k !== 'empty' && name.trim() === t(`templates.names.${k}`))
    setKind(next)
    if (next === 'empty') {
      if (named) setName('')
      return
    }
    if (!name.trim() || named) setName(t(`templates.names.${next}`))
    setColor(TEMPLATES[next].color)
    setIcon(TEMPLATES[next].icon)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    if (list) {
      const change: Record<string, string> = {}
      if (name.trim() !== list.name) change.name = name
      if (color !== list.color) change.color = color
      if (icon !== list.icon) change.icon = icon
      if (Object.keys(change).length) engine.put('list', list.id, change)
      if (space !== list.space_id) moveList(engine, view, list.id, space, view.listsOf(space).length)
      onClose()
    } else {
      const id = createList(engine, view, space, name, color, icon)
      fillList(engine, id, kind, t, localDay())
      // A list one ticks off as a whole has nothing put off: "Someday" leaves it out on this device.
      if (kind === 'shopping' || kind === 'packing') leaveOut(id, true)
      onClose()
      navigate(`/lists/${id}`)
    }
  }
  return (
    <Dialog title={list ? t('list.editTitle') : t('list.newTitle')} onClose={onClose} medium>
      <form className="space-y-4" onSubmit={submit}>
        <NameField value={name} onChange={setName} label={t('list.name')} color={color} icon={icon} />
        <label className="block text-sm">
          <span className="font-medium text-mist-100">{t('list.space')}</span>
          <select className="nt-field mt-1 px-2" value={space} onChange={(e) => setSpace(e.target.value)}>
            {view.spaces.filter((s) => !view.isHidden(s.id) || s.id === list?.space_id || s.id === spaceId).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {list && space !== list.space_id && <span className="mt-1 block text-xs text-mist-500">{t('list.moveHint')}</span>}
        </label>
        {!list && <TemplateChoice value={kind} onChange={choose} />}

        <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {list && (
            <button
              type="button"
              className="nt-btn nt-btn-quiet mr-auto text-bad-500"
              onClick={() => {
                onClose()
                shell.ask(
                  askTrashList(list, t, () => {
                    engine.trash('list', list.id)
                    navigate('/today')
                  }),
                )
              }}
            >
              {t('list.deleteAsk')}
            </button>
          )}
          <button type="button" className="nt-btn nt-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nt-btn nt-btn-accent" disabled={!valid}>
            {list ? t('common.save') : t('list.create')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** The start of a new list: empty, or a template with its sections and tasks. */
function TemplateChoice({ value, onChange }: { value: TemplateKind; onChange: (kind: TemplateKind) => void }) {
  const { t } = useTranslation()
  return (
    <div className="text-sm" role="radiogroup" aria-labelledby="template-label" data-testid="template-choice">
      <span id="template-label" className="font-medium text-mist-100">
        {t('templates.label')}
      </span>
      <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TEMPLATE_KINDS.map((kind) => {
          const on = kind === value
          const look = kind === 'empty' ? null : TEMPLATES[kind]
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(kind)}
              data-testid={`template-${kind}`}
              className={'flex min-h-[64px] flex-col items-start gap-1 rounded-[10px] border px-2.5 py-2 text-left ' + (on ? 'border-accent-500 bg-accent-wash' : 'border-ink-700 hover:bg-ink-800')}
            >
              <span className="flex items-center gap-1.5 font-semibold text-mist-100">
                {look && createElement(iconFor(look.icon), { className: 'h-4 w-4 shrink-0', strokeWidth: 1.9, style: { color: colorOf(look.color) }, 'aria-hidden': true })}
                {t(`templates.kinds.${kind}`)}
              </span>
              <span className="text-[11.5px] leading-snug text-mist-500">{t(`templates.hints.${kind}`)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** "Copy list": a name, the space, the dates kept or left out; sections and tasks go along, all open. */
export function CopyListDialog({ listId, onClose }: { listId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const list = view.list(listId)
  const [name, setName] = useState(list ? t('templates.copy.name', { name: list.name }) : '')
  const [space, setSpace] = useState(list?.space_id ?? '')
  const [keepDates, setKeepDates] = useState(false)
  const valid = textLength(name.trim()) >= 1 && textLength(name.trim()) <= 80 && !!space
  if (!list) return null
  const dated = view.live.some((r) => r.list_id === listId && r.due_date)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    const id = copyList(engine, view, listId, { name, spaceId: space, keepDates, position: keyAtEnd(view.listsOf(space)) })
    onClose()
    if (id) navigate(`/lists/${id}`)
  }
  return (
    <Dialog title={t('templates.copy.title', { name: list.name })} onClose={onClose} medium>
      <form className="space-y-4" onSubmit={submit} data-testid="copy-list">
        <NameField value={name} onChange={setName} label={t('list.name')} color={list.color} icon={list.icon} />
        <label className="block text-sm">
          <span className="font-medium text-mist-100">{t('list.space')}</span>
          <select className="nt-field mt-1 px-2" value={space} onChange={(e) => setSpace(e.target.value)} data-testid="copy-space">
            {view.spaces
              .filter((s) => !view.isHidden(s.id) || s.id === list.space_id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        {dated && (
          <div className="text-sm" role="radiogroup" aria-labelledby="copy-dates">
            <span id="copy-dates" className="font-medium text-mist-100">
              {t('templates.copy.dates')}
            </span>
            <div className="mt-1 space-y-1.5">
              {[false, true].map((keep) => (
                <label key={String(keep)} className="flex items-start gap-2 text-mist-300">
                  <input type="radio" name="dates" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent-500)]" checked={keepDates === keep} onChange={() => setKeepDates(keep)} data-testid={keep ? 'copy-keep-dates' : 'copy-drop-dates'} />
                  <span>{t(keep ? 'templates.copy.keepDates' : 'templates.copy.dropDates')}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-mist-500">{t('templates.copy.hint')}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="nt-btn nt-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nt-btn nt-btn-accent" disabled={!valid} data-testid="copy-go">
            {t('templates.copy.go')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
