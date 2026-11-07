/**
 * Making and changing spaces and lists: name, colour, symbol; a list also chooses its space. Deleting puts them into
 * the trash (a space only by its managers, "Private" never).
 */
import { Search, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { createList, createSpace, moveList } from '../lib/actions'
import { colorOf, COLOR_NAMES, findSymbols, SYMBOL_GROUPS, type SymbolEntry } from '../lib/look'
import { Badge } from './Badge'
import { useEngine, useView } from '../state/sync'
import { textLength } from '../sync/fields'
import { Dialog } from './Dialog'

/**
 * The symbols, a few hundred of them: a search over names and search words in German and English, otherwise all in
 * their groups. The chosen one stays marked in the field, also when the search hides it.
 */
function SymbolPicker({ color, icon, onIcon }: { color: string; icon: string; onIcon: (i: string) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const title = (entry: SymbolEntry) => t(`look.icons.${entry.name}`)
  const found = useMemo(() => findSymbols(query, (entry) => t(`look.icons.${entry.name}`)), [query, t])
  const searching = query.trim() !== ''

  const button = (entry: SymbolEntry) => (
    <button
      key={entry.name}
      type="button"
      role="radio"
      aria-checked={icon === entry.name}
      aria-label={title(entry)}
      title={title(entry)}
      onClick={() => onIcon(entry.name)}
      className={'grid h-8 w-8 place-items-center rounded-lg ' + (icon === entry.name ? 'text-white' : 'bg-ink-800 text-mist-300 hover:bg-ink-700')}
      style={icon === entry.name ? { background: colorOf(color) } : undefined}
    >
      <entry.icon className="h-4 w-4" />
    </button>
  )

  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-mist-500">{t('look.icon')}</legend>
      <label className="relative mb-2 block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-500" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter takes the only match instead of sending the form.
            if (event.key === 'Enter') {
              event.preventDefault()
              if (found.length === 1) onIcon(found[0].name)
            }
          }}
          placeholder={t('look.iconSearch')}
          aria-label={t('look.iconSearch')}
          className="w-full rounded-lg border border-ink-700 bg-ink-850 py-1.5 pl-8 pr-2 text-sm text-mist-100 placeholder:text-mist-500 focus:border-accent-500 focus:outline-none"
        />
      </label>
      <div className="h-64 overflow-y-auto pr-1" role="radiogroup" aria-label={t('look.icon')}>
        {searching ? (
          found.length > 0 ? (
            <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">{found.map(button)}</div>
          ) : (
            <p className="py-3 text-sm text-mist-500">{t('look.iconNone')}</p>
          )
        ) : (
          SYMBOL_GROUPS.map((group) => (
            <div key={group} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-mist-500">{t(`look.iconGroups.${group}`)}</p>
              <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">{found.filter((entry) => entry.group === group).map(button)}</div>
            </div>
          ))
        )}
      </div>
    </fieldset>
  )
}

export function LookPicker({ color, icon, onColor, onIcon }: { color: string; icon: string; onColor: (c: string) => void; onIcon: (i: string) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-mist-500">{t('look.color')}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('look.color')}>
          {COLOR_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={color === name}
              aria-label={t(`look.colors.${name}`)}
              onClick={() => onColor(name)}
              className={'h-7 w-7 rounded-lg ring-offset-2 ring-offset-ink-900 ' + (color === name ? 'ring-2 ring-mist-300' : '')}
              style={{ background: colorOf(name) }}
            />
          ))}
        </div>
      </fieldset>
      <SymbolPicker color={color} icon={icon} onIcon={onIcon} />
    </>
  )
}

export function NameField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-mist-500">{label}</span>
      <input className="nc-field" value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} autoFocus />
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
  const [sure, setSure] = useState(false)
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
        <div className="flex items-center gap-3">
          <Badge color={color} icon={icon} size="lg" />
          <div className="flex-1">
            <NameField value={name} onChange={setName} label={t('space.name')} />
          </div>
        </div>
        <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
        {!space && <p className="text-xs text-mist-500">{t('space.newHint')}</p>}
        <div className="flex items-center justify-between gap-2">
          {space && !space.private && space.role === 'manager' ? (
            sure ? (
              <button
                type="button"
                className="nc-btn bg-bad-500 text-on-bad"
                onClick={() => {
                  engine.trash('space', space.id)
                  onClose()
                  navigate('/today')
                }}
              >
                <Trash2 className="h-4 w-4" /> {t('space.deleteSure')}
              </button>
            ) : (
              <button type="button" className="nc-btn nc-btn-ghost text-bad-500" onClick={() => setSure(true)}>
                <Trash2 className="h-4 w-4" /> {t('space.delete')}
              </button>
            )
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <button type="button" className="nc-btn nc-btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="nc-btn nc-btn-accent" disabled={!valid}>
              {space ? t('common.save') : t('space.create')}
            </button>
          </span>
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
  const [sure, setSure] = useState(false)
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
        <div className="flex items-center gap-3">
          <Badge color={color} icon={icon} size="lg" />
          <div className="flex-1">
            <NameField value={name} onChange={setName} label={t('list.name')} />
          </div>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-mist-500">{t('list.space')}</span>
          <select className="nc-field" value={space} onChange={(e) => setSpace(e.target.value)}>
            {view.spaces.filter((s) => !view.isHidden(s.id) || s.id === list?.space_id || s.id === spaceId).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {list && space !== list.space_id && <span className="block text-xs text-mist-500">{t('list.moveHint')}</span>}
        </label>
        <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
        <div className="flex items-center justify-between gap-2">
          {list ? (
            sure ? (
              <button
                type="button"
                className="nc-btn bg-bad-500 text-on-bad"
                onClick={() => {
                  engine.trash('list', list.id)
                  onClose()
                  navigate('/today')
                }}
              >
                <Trash2 className="h-4 w-4" /> {t('list.deleteSure')}
              </button>
            ) : (
              <button type="button" className="nc-btn nc-btn-ghost text-bad-500" onClick={() => setSure(true)}>
                <Trash2 className="h-4 w-4" /> {t('list.delete')}
              </button>
            )
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <button type="button" className="nc-btn nc-btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="nc-btn nc-btn-accent" disabled={!valid}>
              {list ? t('common.save') : t('list.create')}
            </button>
          </span>
        </div>
      </form>
    </Dialog>
  )
}
