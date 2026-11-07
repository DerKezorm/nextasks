/**
 * Making and changing an own filter: name, colour, symbol on the left, the conditions on the right as chips. All
 * chosen conditions must match; within one any chosen value does. Which tasks: open ones show the due choices,
 * completed ones the days of completion, all of them both. The number of matches follows every change. A filter has
 * no trash: deleting is for good, after a second click.
 */
import { createElement, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { createFilter, deleteFilter, writeRules } from '../lib/actions'
import { localDay } from '../lib/due'
import { colorOf, iconFor } from '../lib/look'
import { useEngine, useView } from '../state/sync'
import { cleanTags, textLength } from '../sync/fields'
import { DONE_WORDS, DUE_WORDS, FILTER_STATES, filterItems, readRules, type Rules, type Who } from '../sync/tiles'
import { Badge } from './Badge'
import { Dialog } from './Dialog'
import { personName } from './People'
import { LookPicker, NameField } from './ThingDialogs'

/** The most the server takes for the conditions, written out (contract 0.5). */
const RULES_MAX = 4000

/** One value to switch on and off: a pill, petrol when on. */
function Chip({ on, onClick, children, label, testId }: { on: boolean; onClick: () => void; children: ReactNode; label?: string; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium ' + (on ? 'border-accent-500/60 bg-accent-500/15 text-accent-400' : 'border-ink-700 bg-ink-900 text-mist-300 hover:text-mist-100')}
    >
      {children}
    </button>
  )
}

/** A condition: its name, a line of help when needed, and its values. */
function Condition({ title, hint, children, testId }: { title: string; hint?: string; children: ReactNode; testId?: string }) {
  return (
    <fieldset className="space-y-1.5" data-testid={testId}>
      <legend className="mb-1.5 text-xs font-medium text-mist-500">
        {title}
        {hint && <span className="font-normal text-mist-600"> · {hint}</span>}
      </legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  )
}

function toggled<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

export function FilterDialog({ filterId, onClose }: { filterId: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const navigate = useNavigate()
  const filter = filterId ? view.filter(filterId) : undefined
  const [name, setName] = useState(filter?.name ?? '')
  const [color, setColor] = useState(filter?.color ?? 'blue')
  const [icon, setIcon] = useState(filter?.icon ?? 'filter')
  const [rules, setRules] = useState<Rules>(() => readRules(filter?.rules))
  const [tag, setTag] = useState('')
  const [sure, setSure] = useState(false)
  const change = (part: Partial<Rules>) => setRules((was) => ({ ...was, ...part }))

  const stored = writeRules(rules, filter?.rules)
  const tooLong = JSON.stringify(stored).length > RULES_MAX
  const valid = textLength(name.trim()) >= 1 && textLength(name.trim()) <= 80 && !tooLong
  const matches = filterItems(view, stored, localDay()).length

  // Places: every space one is in (hidden ones too, a filter may name them), each with its lists.
  const knownSpaces = new Set(view.spaces.map((s) => s.id))
  const knownLists = new Set(view.spaces.flatMap((s) => view.listsOf(s.id).map((l) => l.id)))
  const gone = rules.spaces.filter((id) => !knownSpaces.has(id)).length + rules.lists.filter((id) => !knownLists.has(id)).length

  // People: oneself, nobody, everyone of the shared spaces, and whoever the filter names already.
  const people = useMemo(() => {
    const ids = new Set<number>()
    for (const space of view.spaces) if (!space.private) for (const m of view.membersOf(space.id)) if (m.account_id !== view.me) ids.add(m.account_id)
    for (const who of rules.assignees) if (typeof who === 'number' && who !== view.me) ids.add(who)
    return [...ids].map((id) => ({ id, name: personName(view.people.get(id), t) })).sort((a, b) => a.name.localeCompare(b.name))
  }, [view, rules.assignees, t])

  // Tags: the chosen ones first, then the others in use as suggestions.
  const fold = (text: string) => text.normalize('NFC').toLowerCase()
  const chosen = new Set(rules.tags.map(fold))
  const suggestions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of view.live) for (const tag of r.tags) if (!seen.has(fold(tag))) seen.set(fold(tag), tag)
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [view])
  const addTag = () => {
    const [clean] = cleanTags([tag])
    if (clean && !chosen.has(fold(clean))) change({ tags: [...rules.tags, clean] })
    setTag('')
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    if (filter) {
      const fields: Record<string, unknown> = {}
      if (name.trim() !== filter.name) fields.name = name
      if (color !== filter.color) fields.color = color
      if (icon !== filter.icon) fields.icon = icon
      if (JSON.stringify(stored) !== JSON.stringify(filter.rules)) fields.rules = stored
      if (Object.keys(fields).length) engine.put('filter', filter.id, fields)
      onClose()
    } else {
      const id = createFilter(engine, view, { name, color, icon, rules: stored })
      onClose()
      navigate(`/filters/${id}`)
    }
  }

  const who = (value: Who, label: string) => (
    <Chip key={String(value)} on={rules.assignees.includes(value)} onClick={() => change({ assignees: toggled(rules.assignees, value) })} testId={`who-${value}`}>
      {label}
    </Chip>
  )

  const footer = (
    <div className="flex items-center justify-between gap-2">
      {filter ? (
        sure ? (
          <button
            type="button"
            className="nc-btn bg-bad-500 text-on-bad"
            onClick={() => {
              deleteFilter(engine, filter.id)
              onClose()
              if (window.location.pathname === `/filters/${filter.id}`) navigate('/today')
            }}
          >
            <Trash2 className="h-4 w-4" /> {t('filter.deleteSure')}
          </button>
        ) : (
          <button type="button" className="nc-btn nc-btn-ghost text-bad-500" onClick={() => setSure(true)}>
            <Trash2 className="h-4 w-4" /> {t('filter.delete')}
          </button>
        )
      ) : (
        <span />
      )}
      <span className="flex gap-2">
        <button type="button" className="nc-btn nc-btn-ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" form="filter-form" className="nc-btn nc-btn-accent" disabled={!valid}>
          {filter ? t('common.save') : t('filter.create')}
        </button>
      </span>
    </div>
  )

  return (
    <Dialog title={filter ? t('filter.editTitle') : t('filter.newTitle')} onClose={onClose} huge footer={footer}>
      <form id="filter-form" className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" onSubmit={submit}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge color={color} icon={icon} size="lg" />
            <div className="flex-1">
              <NameField value={name} onChange={setName} label={t('filter.name')} />
            </div>
          </div>
          <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
        </div>

        <div className="space-y-4" data-testid="filter-conditions">
          <div>
            <h3 className="text-sm font-semibold text-mist-100">{t('filter.conditions')}</h3>
            <p className="text-xs text-mist-500">{t('filter.conditionsHint')}</p>
          </div>

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('filter.state')}>
            {FILTER_STATES.map((state) => (
              <button
                key={state}
                type="button"
                role="radio"
                aria-checked={rules.state === state}
                data-testid={`state-${state}`}
                onClick={() => change({ state })}
                className={'rounded-full border px-4 py-1.5 text-sm font-medium ' + (rules.state === state ? 'border-accent-500/60 bg-accent-500/15 text-accent-400' : 'border-ink-700 bg-ink-900 text-mist-500 hover:text-mist-100')}
              >
                {t(`filter.states.${state}`)}
              </button>
            ))}
          </div>

          {rules.state !== 'completed' && (
            <Condition title={t('filter.due')} hint={rules.state === 'all' ? t('filter.dueHint') : undefined} testId="condition-due">
              {DUE_WORDS.map((word) => (
                <Chip key={word} on={rules.due.includes(word)} onClick={() => change({ due: toggled(rules.due, word) })} testId={`due-${word}`}>
                  {t(`filter.dueWords.${word}`)}
                </Chip>
              ))}
            </Condition>
          )}

          {rules.state !== 'open' && (
            <Condition title={t('filter.done')} hint={rules.state === 'all' ? t('filter.doneHint') : undefined} testId="condition-done">
              {DONE_WORDS.map((word) => (
                <Chip key={word} on={rules.done.includes(word)} onClick={() => change({ done: toggled(rules.done, word) })} testId={`done-${word}`}>
                  {t(`filter.doneWords.${word}`)}
                </Chip>
              ))}
            </Condition>
          )}

          <fieldset className="space-y-2" data-testid="condition-place">
            <legend className="mb-1.5 text-xs font-medium text-mist-500">{t('filter.place')}</legend>
            {view.spaces.map((space) => (
              <div key={space.id} className="flex flex-wrap gap-1.5">
                <Chip on={rules.spaces.includes(space.id)} onClick={() => change({ spaces: toggled(rules.spaces, space.id) })} testId={`place-space-${space.name}`}>
                  {createElement(iconFor(space.icon), { className: 'h-3.5 w-3.5 shrink-0', strokeWidth: 2, 'aria-hidden': true })}
                  <span className="truncate font-semibold">{space.name}</span>
                </Chip>
                {view.listsOf(space.id).map((list) => (
                  <Chip key={list.id} on={rules.lists.includes(list.id)} onClick={() => change({ lists: toggled(rules.lists, list.id) })} testId={`place-list-${list.name}`}>
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(list.color) }} aria-hidden />
                    <span className="truncate">{list.name}</span>
                  </Chip>
                ))}
              </div>
            ))}
            {gone > 0 && (
              <p className="flex items-center gap-2 text-xs text-mist-500">
                {t('filter.placeGone', { count: gone })}
                <button type="button" className="font-semibold text-accent-400" onClick={() => change({ spaces: rules.spaces.filter((id) => knownSpaces.has(id)), lists: rules.lists.filter((id) => knownLists.has(id)) })}>
                  {t('filter.removeGone')}
                </button>
              </p>
            )}
          </fieldset>

          <Condition title={t('filter.flagged')}>
            <Chip on={rules.flagged} onClick={() => change({ flagged: !rules.flagged })} testId="flagged">
              {t('filter.flaggedOnly')}
            </Chip>
          </Condition>

          <Condition title={t('detail.assignees')} testId="condition-assignees">
            {who('me', t('filter.me'))}
            {who('nobody', t('filter.nobody'))}
            {people.map((person) => who(person.id, person.name))}
          </Condition>

          <Condition title={t('detail.priority')} testId="condition-priority">
            {[3, 2, 1, 0].map((p) => (
              <Chip key={p} on={rules.priority.includes(p)} onClick={() => change({ priority: toggled(rules.priority, p) })} testId={`priority-${p}`}>
                {t(`priority.${p}`)}
              </Chip>
            ))}
          </Condition>

          <Condition title={t('detail.tags')} testId="condition-tags">
            {rules.tags.map((value) => (
              <Chip key={value} on onClick={() => change({ tags: rules.tags.filter((v) => v !== value) })} label={t('detail.removeTag', { tag: value })}>
                #{value} <X className="h-3 w-3" aria-hidden />
              </Chip>
            ))}
            {suggestions
              .filter((value) => !chosen.has(fold(value)))
              .slice(0, 20)
              .map((value) => (
                <Chip key={value} on={false} onClick={() => change({ tags: [...rules.tags, value] })}>
                  #{value}
                </Chip>
              ))}
            <span className="inline-flex items-center gap-1">
              <input
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                onKeyDown={(event) => {
                  // Enter takes the tag instead of sending the form.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addTag()
                  }
                }}
                placeholder={t('filter.addTag')}
                aria-label={t('filter.addTag')}
                maxLength={60}
                className="w-40 rounded-full border border-ink-700 bg-ink-850 px-3 py-1 text-[13px] text-mist-100 placeholder:text-mist-500 focus:border-accent-500 focus:outline-none"
              />
              <button type="button" onClick={addTag} disabled={!tag.trim()} className="rounded-full p-1 text-mist-500 hover:text-mist-100 disabled:opacity-40" aria-label={t('filter.add')} title={t('filter.add')}>
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </span>
          </Condition>

          <p className="text-sm text-mist-300" role="status" data-testid="filter-matches">
            {tooLong ? <span className="text-bad-500">{t('filter.tooLong')}</span> : t('filter.matches', { count: matches })}
          </p>
        </div>
      </form>
    </Dialog>
  )
}
