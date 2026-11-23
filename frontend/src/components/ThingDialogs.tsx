/**
 * Making and changing spaces and lists: name, colour, symbol; a list also chooses its space. Deleting asks first and
 * puts them into the trash (a space only by its managers, "Private" never).
 */
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { createList, createSpace, moveList } from '../lib/actions'
import { colorOf } from '../lib/look'
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
  const shell = useShell()
  const valid = textLength(name.trim()) >= 1 && textLength(name.trim()) <= 80 && !!space
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
