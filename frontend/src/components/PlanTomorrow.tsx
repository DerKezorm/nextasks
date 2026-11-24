/**
 * "Plan tomorrow": everything that stayed open today (and before), each to tomorrow, to some time (no date) or into the
 * bin, one by one or all at once; below, what tomorrow already holds. A task into the bin comes back with "Undo" as
 * everywhere; all of them at once asks first. A repeating task keeps its date: without one it would lose its rule.
 */
import { CalendarOff, CalendarPlus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { dueChange, moveToDay, trashReminder } from '../lib/actions'
import { dueLabel, localDay } from '../lib/due'
import { showNotice } from '../lib/notice'
import { dueOn, leftOpen } from '../lib/today'
import { useEngine, useView } from '../state/sync'
import { addDays } from '../sync/repeat'
import type { Reminder } from '../sync/types'
import { ConfirmDialog, type Question } from './ConfirmDialog'
import { Dialog } from './Dialog'
import { Mark } from './Mark'

const ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-md text-mist-500 hover:bg-ink-800 hover:text-mist-100 disabled:opacity-35 disabled:hover:bg-transparent'

export function PlanTomorrow({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const [question, setQuestion] = useState<Question | null>(null)
  const today = localDay()
  const tomorrow = addDays(today, 1)
  const items = leftOpen(view, today)
  const coming = dueOn(view, tomorrow)

  const toTomorrow = (list: Reminder[]) => list.forEach((r) => moveToDay(engine, r, tomorrow))
  const someTime = (list: Reminder[]) => list.filter((r) => !r.repeat).forEach((r) => engine.put('reminder', r.id, dueChange(r, null, null)))
  const trashAll = (list: Reminder[]) => {
    for (const r of list) engine.trash('reminder', r.id)
    showNotice({ text: t('today.plan.trashed', { count: list.length }), undo: () => list.forEach((r) => engine.trash('reminder', r.id, true)) })
  }

  return (
    <Dialog
      title={t('today.plan.title')}
      onClose={onClose}
      medium
      footer={
        <button type="button" className="nt-btn nt-btn-accent" onClick={onClose}>
          {t('today.plan.close')}
        </button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="plan-tomorrow">
        {items.length ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm text-mist-300">{t('today.plan.left', { count: items.length })}</p>
              <button type="button" className="nt-btn nt-btn-ghost h-8 px-3" onClick={() => toTomorrow(items)} data-testid="plan-all-tomorrow">
                {t('today.plan.allTomorrow')}
              </button>
              <button type="button" className="nt-btn nt-btn-ghost h-8 px-3" disabled={items.every((r) => r.repeat)} onClick={() => someTime(items)} data-testid="plan-all-sometime">
                {t('today.plan.allSometime')}
              </button>
              <button
                type="button"
                className="nt-btn nt-btn-ghost h-8 px-3 text-bad-500"
                onClick={() => setQuestion({ title: t('today.plan.trashAllTitle', { count: items.length }), text: t('today.plan.trashAllText'), confirm: t('today.plan.trashAll'), run: () => trashAll(items) })}
                data-testid="plan-all-trash"
              >
                {t('today.plan.trashAll')}
              </button>
            </div>
            <ul className="nt-group" role="list">
              {items.map((reminder) => {
                const list = view.list(reminder.list_id)
                const late = reminder.due_date! < today
                return (
                  <li key={reminder.id} className="flex items-center gap-2.5 border-t border-ink-700 px-3 py-2 first:border-t-0" data-testid="plan-item">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] text-mist-100">{reminder.title}</span>
                      <span className="flex items-center gap-2 text-[12px] text-mist-500">
                        <span className={late ? 'font-semibold text-late' : 'font-semibold text-accent-400'}>{dueLabel(reminder, today, i18n.language, t)}</span>
                        {list && (
                          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                            <Mark color={list.color} icon={list.icon} size={12} /> {list.name}
                          </span>
                        )}
                      </span>
                    </span>
                    <button type="button" className={ICON} onClick={() => toTomorrow([reminder])} aria-label={t('today.plan.tomorrowOne', { title: reminder.title })} title={t('today.plan.tomorrow')}>
                      <CalendarPlus className="h-4 w-4" strokeWidth={1.9} aria-hidden />
                    </button>
                    <button type="button" className={ICON} disabled={!!reminder.repeat} onClick={() => someTime([reminder])} aria-label={t('today.plan.sometimeOne', { title: reminder.title })} title={t(reminder.repeat ? 'today.plan.repeatKeeps' : 'today.plan.sometime')}>
                      <CalendarOff className="h-4 w-4" strokeWidth={1.9} aria-hidden />
                    </button>
                    <button type="button" className={ICON + ' hover:text-bad-500'} onClick={() => trashReminder(engine, reminder, (title) => t('reminder.trashed', { title }))} aria-label={t('today.plan.trashOne', { title: reminder.title })} title={t('today.plan.trash')}>
                      <Trash2 className="h-4 w-4" strokeWidth={1.9} aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <p className="text-sm text-mist-300" data-testid="plan-nothing">
            {t('today.plan.nothing')}
          </p>
        )}
        <section aria-label={t('today.plan.coming')}>
          <h3 className="nt-sec mb-1.5">{t('today.plan.coming')}</h3>
          {coming.length ? (
            <ul className="flex flex-col gap-1 text-[13.5px] text-mist-200" data-testid="plan-coming">
              {coming.slice(0, 8).map((reminder) => (
                <li key={reminder.id} className="truncate">
                  {reminder.due_time && <span className="mr-1.5 text-mist-500 tabular-nums">{reminder.due_time}</span>}
                  {reminder.title}
                </li>
              ))}
              {coming.length > 8 && <li className="text-mist-500">{t('today.tomorrow.more', { count: coming.length - 8 })}</li>}
            </ul>
          ) : (
            <p className="text-[13.5px] text-mist-500">{t('today.tomorrow.none')}</p>
          )}
        </section>
      </div>
      {question && <ConfirmDialog question={question} onClose={() => setQuestion(null)} />}
    </Dialog>
  )
}
