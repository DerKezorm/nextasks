/**
 * The line for a new task, in plain words (data model, "Schnelleingabe"): what it recognises shows as chips
 * below while typing; Enter makes the task and keeps the line open for the next. With `shop` (the line of a list
 * without a section): what was done often in the list comes up while typing, and a new task goes into the section its
 * title stood in last (`lib/shop.ts`).
 */
import { CalendarDays, ChevronsUp, Clock, Hash, Plus } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createReminder, type Spot } from '../lib/actions'
import { dayLabel, localDay, localTime } from '../lib/due'
import { addSorted, matching, quantityOf, type Suggestion } from '../lib/shop'
import { useEngine, useView } from '../state/sync'
import { parseQuick } from '../sync/quick'
import type { Data, Section } from '../sync/types'
import { useShell } from './Shell'

/** What a list's line knows to help with shopping. */
export interface ShopHelp {
  /** Often done and not open now. */
  suggestions: Suggestion[]
  /** The section a task of this title goes into, when none was chosen. */
  place: (title: string) => Section | null
}

export function QuickEntry({ spot, defaults = {}, label, register = true, shop }: { spot: Spot | null; defaults?: Data; label?: string; register?: boolean; shop?: ShopHelp }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [text, setText] = useState('')
  const [pick, setPick] = useState(-1)
  const field = useRef<HTMLInputElement>(null)
  const offerId = useId()
  const language = i18n.language.startsWith('de') ? 'de' : 'en'
  const today = localDay()
  const parsed = useMemo(() => parseQuick(text, { language, today, now: localTime() }), [text, language, today])
  const target = spot ?? (view.defaultList ? { list_id: view.defaultList.id, section_id: null, parent_id: null } : null)
  const sorting = !!shop && !!target && !target.section_id && !target.parent_id
  const offered = shop ? matching(shop.suggestions, parsed.title || text) : []
  const chosen = pick < offered.length ? pick : -1
  const sorted = (section: string) => t('shop.sorted', { section })

  useEffect(() => {
    if (!register) return
    shell.registerQuick(() => field.current?.focus())
    return () => shell.registerQuick(null)
  }, [register, shell])

  /** A suggestion taken: its title (with the count typed before it) into the section it stood in last. */
  const take = (suggestion: Suggestion) => {
    if (!target) return
    const section = (suggestion.section_id ? view.section(suggestion.section_id) : undefined) ?? shop?.place(suggestion.title) ?? null
    addSorted(engine, view, target.list_id, { ...defaults, title: quantityOf(text) + suggestion.title }, sorting ? section : null, sorted)
    setText('')
    setPick(-1)
    field.current?.focus()
  }

  const submit = () => {
    if (!target) return
    // An empty title after the words were taken out: the text as typed is the title.
    const title = parsed.title || text.trim()
    if (!title) return
    const fields: Data = { ...defaults, title }
    if (parsed.due_date) {
      fields.due_date = parsed.due_date
      fields.due_time = parsed.due_time
      fields.repeat = null
      fields.repeat_from = 'due'
    }
    if (parsed.tags.length) fields.tags = parsed.tags
    if (parsed.priority) fields.priority = parsed.priority
    if (sorting) addSorted(engine, view, target.list_id, fields, shop.place(title), sorted)
    else createReminder(engine, view, target, fields)
    setText('')
    setPick(-1)
  }

  /** Up and down walk through the suggestions and back into the line. */
  const walk = (step: number) => {
    const places = offered.length + 1
    const next = (chosen + 1 + step + places) % places
    setPick(next - 1)
  }

  const chips: { key: string; icon: typeof Hash; text: string }[] = []
  if (parsed.due_date) chips.push({ key: 'date', icon: CalendarDays, text: dayLabel(parsed.due_date, today, i18n.language, t) })
  if (parsed.due_time) chips.push({ key: 'time', icon: Clock, text: parsed.due_time })
  if (parsed.priority) chips.push({ key: 'priority', icon: ChevronsUp, text: t(`priority.${parsed.priority}`) })
  for (const tag of parsed.tags) chips.push({ key: 'tag' + tag, icon: Hash, text: tag })

  return (
    <div>
      <form
        className="flex items-center gap-[11px] px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (chosen >= 0) take(offered[chosen])
          else submit()
        }}
      >
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center text-petrol">
          <Plus className="h-5 w-5" strokeWidth={2.2} aria-hidden />
        </span>
        <input
          ref={field}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setPick(-1)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (chosen >= 0) setPick(-1)
              else {
                setText('')
                field.current?.blur()
              }
            } else if (offered.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              event.stopPropagation()
              walk(event.key === 'ArrowDown' ? 1 : -1)
            }
          }}
          disabled={!target}
          placeholder={label ?? t('quick.placeholder')}
          aria-label={label ?? t('quick.placeholder')}
          data-testid="quick-entry"
          role={shop ? 'combobox' : undefined}
          aria-expanded={shop ? offered.length > 0 : undefined}
          aria-controls={shop && offered.length ? offerId : undefined}
          aria-autocomplete={shop ? 'list' : undefined}
          aria-activedescendant={chosen >= 0 ? `${offerId}-${chosen}` : undefined}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[15px] text-mist-100 placeholder:text-mist-500 focus:outline-none"
        />
      </form>
      {offered.length > 0 && (
        <div id={offerId} role="listbox" aria-label={t('shop.offered')} className="mr-3 mb-2 ml-[45px] flex flex-col overflow-hidden rounded-[10px] border border-ink-700 bg-ink-850" data-testid="quick-offers">
          {offered.map((suggestion, index) => (
            <button
              key={suggestion.key}
              id={`${offerId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === chosen}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => take(suggestion)}
              className={'flex items-center gap-2 px-3 py-1.5 text-left text-sm ' + (index === chosen ? 'bg-accent-wash text-accent-400' : 'text-mist-100 hover:bg-ink-800')}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-petrol" strokeWidth={2.2} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{quantityOf(text) + suggestion.title}</span>
              {suggestion.section_name && <span className="shrink-0 text-xs text-mist-500">{suggestion.section_name}</span>}
            </button>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="mb-2 ml-[45px] flex flex-wrap gap-1.5" aria-live="polite" data-testid="quick-chips">
          {chips.map(({ key, icon: Icon, text: chip }) => (
            <span key={key} className="nt-chip border-accent-500/40 text-accent-400">
              <Icon className="h-3 w-3" aria-hidden /> {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
