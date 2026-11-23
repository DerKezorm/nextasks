/**
 * Making and changing an own filter, as nexnotes' smart folder: the name with its look in front, symbol and colour
 * folded away below it, then the conditions as chips. All chosen conditions must match; within one any chosen value
 * does. Which tasks: open ones show the due choices, completed ones the days of completion, all of them both. The
 * number of matches follows every change. A filter has no trash: deleting is for good, after the question.
 */
import { createElement, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { createFilter, deleteFilter, writeRules } from '../lib/actions'
import { localDay } from '../lib/due'
import { colorOf, iconFor } from '../lib/look'
import { useEngine, useView } from '../state/sync'
import { cleanTags, textLength } from '../sync/fields'
import { DONE_WORDS, DUE_WORDS, FILTER_STATES, filterItems, readRules, type Rules, type Who } from '../sync/tiles'
import { Dialog } from './Dialog'
import { askDeleteFilter } from './Menus'
import { personName } from './People'
import { useShell } from './Shell'
import { LookPicker, NameField } from './ThingDialogs'

/** The most the server takes for the conditions, written out (contract 0.5). */
const RULES_MAX = 4000

/** One value to switch on and off: a chip as nexnotes' search filters, petrol on the wash when on. */
function Chip({ on, onClick, children, label, testId }: { on: boolean; onClick: () => void; children: ReactNode; label?: string; testId?: string }) {
  return (
    <button type="button" aria-pressed={on} aria-label={label} data-testid={testId} onClick={onClick} className="nt-toggle">
      {children}
    </button>
  )
}

/** A condition: its name, a line of help when needed, and its values. */
function Condition({ title, hint, children, testId }: { title: string; hint?: string; children: ReactNode; testId?: string }) {
  return (
    <fieldset className="space-y-1.5" data-testid={testId}>
      <legend className="nt-legend">
        {title}
        {hint && <span className="font-normal tracking-normal text-mist-600 normal-case"> · {hint}</span>}
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
  const location = useLocation()
  const filter = filterId ? view.filter(filterId) : undefined
  const [name, setName] = useState(filter?.name ?? '')
  const [color, setColor] = useState(filter?.color ?? 'blue')
  const [icon, setIcon] = useState(filter?.icon ?? 'filter')
  const [rules, setRules] = useState<Rules>(() => readRules(filter?.rules))
  const [tag, setTag] = useState('')
  const shell = useShell()
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
    <>
      {filter && (
        <button
          type="button"
          className="nt-btn nt-btn-quiet mr-auto text-bad-500"
          onClick={() => {
            onClose()
            shell.ask(
              askDeleteFilter(filter, t, () => {
                deleteFilter(engine, filter.id)
                if (location.pathname === `/filters/${filter.id}`) navigate('/today')
              }),
            )
          }}
        >
          {t('filter.deleteAsk')}
        </button>
      )}
      <button type="button" className="nt-btn nt-btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="submit" form="filter-form" className="nt-btn nt-btn-accent" disabled={!valid}>
        {filter ? t('common.save') : t('filter.create')}
      </button>
    </>
  )

  return (
    <Dialog title={filter ? t('filter.editTitle') : t('filter.newTitle')} onClose={onClose} wide footer={footer}>
      <form id="filter-form" className="space-y-5" onSubmit={submit}>
        <div className="space-y-3">
          <NameField value={name} onChange={setName} label={t('filter.name')} color={color} icon={icon} />
          <details className="rounded-[12px] border border-ink-700 bg-ink-900 px-3.5 py-2.5" data-testid="filter-look">
            <summary className="cursor-pointer text-[13px] font-semibold select-none">{t('look.title')}</summary>
            <div className="mt-3 space-y-4">
              <LookPicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
            </div>
          </details>
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
                className="nt-toggle px-4"
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
            <legend className="nt-legend">{t('filter.place')}</legend>
            {view.spaces.map((space) => (
              <div key={space.id} className="flex flex-wrap gap-1.5">
                <Chip on={rules.spaces.includes(space.id)} onClick={() => change({ spaces: toggled(rules.spaces, space.id) })} testId={`place-space-${space.name}`}>
                  {createElement(iconFor(space.icon), { className: 'h-3.5 w-3.5 shrink-0', strokeWidth: 2, 'aria-hidden': true })}
                  <span className="truncate font-semibold">{space.name}</span>
                </Chip>
                {view.listsOf(space.id).map((list) => (
                  <Chip key={list.id} on={rules.lists.includes(list.id)} onClick={() => change({ lists: toggled(rules.lists, list.id) })} testId={`place-list-${list.name}`}>
                    {createElement(iconFor(list.icon), { className: 'h-3.5 w-3.5 shrink-0', strokeWidth: 2, style: { color: colorOf(list.color) }, 'aria-hidden': true })}
                    <span className="truncate">{list.name}</span>
                  </Chip>
                ))}
              </div>
            ))}
            {gone > 0 && (
              <p className="flex items-center gap-2 text-xs text-mist-500">
                {t('filter.placeGone', { count: gone })}
                <button type="button" className="nt-btn-quiet font-semibold" onClick={() => change({ spaces: rules.spaces.filter((id) => knownSpaces.has(id)), lists: rules.lists.filter((id) => knownLists.has(id)) })}>
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
                className="nt-field h-[34px] w-40 rounded-full text-[13px]"
              />
              <button type="button" onClick={addTag} disabled={!tag.trim()} className="nt-icon-btn" aria-label={t('filter.add')} title={t('filter.add')}>
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
