/**
 * The line for a new task, in plain words (data model, "Schnelleingabe"): what it recognises shows as chips
 * below while typing; Enter makes the task and keeps the line open for the next.
 */
import { CalendarDays, ChevronsUp, Clock, Hash, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createReminder, type Spot } from '../lib/actions'
import { dayLabel, localDay, localTime } from '../lib/due'
import { useEngine, useView } from '../state/sync'
import { parseQuick } from '../sync/quick'
import type { Data } from '../sync/types'
import { useShell } from './Shell'

export function QuickEntry({ spot, defaults = {}, label, register = true }: { spot: Spot | null; defaults?: Data; label?: string; register?: boolean }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const language = i18n.language.startsWith('de') ? 'de' : 'en'
  const today = localDay()
  const parsed = useMemo(() => parseQuick(text, { language, today, now: localTime() }), [text, language, today])
  const target = spot ?? (view.defaultList ? { list_id: view.defaultList.id, section_id: null, parent_id: null } : null)

  useEffect(() => {
    if (!register) return
    shell.registerQuick(() => field.current?.focus())
    return () => shell.registerQuick(null)
  }, [register, shell])

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
    createReminder(engine, view, target, fields)
    setText('')
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
          submit()
        }}
      >
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center text-petrol">
          <Plus className="h-5 w-5" strokeWidth={2.2} aria-hidden />
        </span>
        <input
          ref={field}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setText('')
              field.current?.blur()
            }
          }}
          disabled={!target}
          placeholder={label ?? t('quick.placeholder')}
          aria-label={label ?? t('quick.placeholder')}
          data-testid="quick-entry"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[15px] text-mist-100 placeholder:text-mist-500 focus:outline-none"
        />
      </form>
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
