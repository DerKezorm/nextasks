/**
 * The small buttons of a task's row under the pointer (and with the focus in the row): the date (today, tomorrow,
 * next week, a day to pick, no date), who it is assigned to (only in a shared space), the mark and, on "Today", the
 * star that puts it into the focus of the day. The same changes as
 * the context menu and the detail make (`dueChange`). On a phone or a touch screen they never show (`.nt-row-acts`).
 */
import { Bookmark, CalendarDays, Check, Star, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { dueChange } from '../lib/actions'
import { localDay } from '../lib/due'
import { useFocusOffered } from '../lib/focus'
import { assignable } from '../lib/shared'
import { parkReminder } from '../lib/someday'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { PersonAvatar, personName } from './People'
import { Popover } from './Popover'

const BUTTON =
  'grid h-7 w-7 place-items-center rounded-md text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-100 aria-expanded:bg-accent-wash aria-expanded:text-accent-400 aria-pressed:text-petrol'

export function RowActions({ reminder }: { reminder: Reminder }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const members = assignable(view, reminder.list_id)
  const put = (fields: Record<string, unknown>) => engine.put('reminder', reminder.id, fields)
  const mark = t(reminder.flagged ? 'menu.unmark' : 'menu.mark')
  const focus = useFocusOffered()
  const inFocus = !!focus?.has(reminder.id)
  const star = t(inFocus ? 'today.focus.remove' : focus?.full ? 'today.focus.full' : 'today.focus.add')
  return (
    <span className="nt-row-acts items-center gap-0.5" data-testid="row-actions">
      {focus?.ready && (
        <button type="button" className={BUTTON} aria-pressed={inFocus} aria-label={star} title={star} disabled={!inFocus && focus.full} onClick={() => focus.toggle(reminder.id)} data-testid="row-focus">
          <Star className={'h-4 w-4 ' + (inFocus ? 'fill-current' : '')} strokeWidth={1.9} aria-hidden />
        </button>
      )}
      <Popover label={t('row.date')} button={<CalendarDays className="h-4 w-4" strokeWidth={1.9} aria-hidden />} className={BUTTON}>
        {(close) => <DueChoices reminder={reminder} close={close} />}
      </Popover>
      {members.length > 0 && (
        <Popover label={t('row.assign')} button={<Users className="h-4 w-4" strokeWidth={1.9} aria-hidden />} className={BUTTON}>
          {() =>
            members.map((member) => {
              const on = reminder.assignees.includes(member.account_id)
              const person = view.people.get(member.account_id)
              return (
                <button
                  key={member.account_id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className="nt-menu-item"
                  onClick={() => put({ assignees: on ? reminder.assignees.filter((x) => x !== member.account_id) : [...reminder.assignees, member.account_id] })}
                >
                  <PersonAvatar id={member.account_id} person={person} className="h-5 w-5 text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{personName(person, t)}</span>
                  <Check className={'h-4 w-4 shrink-0 text-accent-400 ' + (on ? '' : 'invisible')} aria-hidden />
                </button>
              )
            })
          }
        </Popover>
      )}
      <button type="button" className={BUTTON} aria-pressed={reminder.flagged} aria-label={mark} title={mark} onClick={() => put({ flagged: !reminder.flagged })} data-testid="row-mark">
        <Bookmark className={'h-4 w-4 ' + (reminder.flagged ? 'fill-current' : '')} strokeWidth={1.9} aria-hidden />
      </button>
    </span>
  )
}

/** The choices of the date button. "Pick a date" opens a date field in the menu; Enter or "Set" takes the day. */
function DueChoices({ reminder, close }: { reminder: Reminder; close: () => void }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const today = localDay()
  const [picking, setPicking] = useState(false)
  const [day, setDay] = useState(reminder.due_date ?? today)
  const set = (date: string | null) => {
    engine.put('reminder', reminder.id, dueChange(reminder, date, reminder.due_time))
    close()
  }
  const choices: [string, string][] = [
    [t('detail.today'), today],
    [t('menu.tomorrow'), addDays(today, 1)],
    [t('menu.nextWeek'), addDays(today, 7)],
  ]
  return (
    <>
      {choices.map(([label, date]) => (
        <button key={label} type="button" role="menuitemradio" aria-checked={reminder.due_date === date} className="nt-menu-item" onClick={() => set(date)}>
          <span className="min-w-0 flex-1">{label}</span>
          <Check className={'h-4 w-4 shrink-0 text-accent-400 ' + (reminder.due_date === date ? '' : 'invisible')} aria-hidden />
        </button>
      ))}
      <div className="nt-menu-line" role="separator" />
      {picking ? (
        <form
          className="flex items-center gap-1.5 px-1.5 py-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (day) set(day)
          }}
        >
          <input
            type="date"
            autoFocus
            value={day}
            onChange={(event) => setDay(event.target.value)}
            // The arrows change the date here, they do not walk through the menu.
            onKeyDown={(event) => event.key !== 'Escape' && event.key !== 'Tab' && event.stopPropagation()}
            aria-label={t('row.pickDate')}
            className="nt-field h-8 min-w-0 flex-1 px-2"
            data-testid="row-date-field"
          />
          <button type="submit" role="menuitem" className="nt-btn nt-btn-accent h-8 px-3" disabled={!day}>
            {t('row.setDate')}
          </button>
        </form>
      ) : (
        <button type="button" role="menuitem" className="nt-menu-item" onClick={() => setPicking(true)} data-testid="row-pick-date">
          {t('row.pickDate')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="nt-menu-item"
        disabled={!reminder.due_date}
        onClick={() => {
          parkReminder(engine, reminder, (title) => t('someday.moved', { title }))
          close()
        }}
        data-testid="row-someday"
      >
        {t('someday.set')}
      </button>
    </>
  )
}
