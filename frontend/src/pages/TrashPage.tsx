/**
 * The trash, as nexnotes': one flat list of what was deleted, newest first, with where it came from, when, and how
 * long it stays; in the last days the time left is orange. Spaces, lists and tasks deleted themselves (not those that
 * only went along with a parent) come back with "Restore" for 30 days from deleting (a space only by its managers);
 * then the server removes them for good. There is no deleting for good by hand: the app's interface has no way to.
 */
import { SquareCheck, Trash2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '../components/EmptyState'
import { Mark } from '../components/Mark'
import { useTrashMenu } from '../components/Menus'
import { moment } from '../lib/time'
import { useEngine, useView } from '../state/sync'

/** The days the trash keeps a thing; in the last ones the time left turns orange. */
const KEEP_DAYS = 30
const WARN_DAYS = 3

function daysLeft(deletedAt: string | null): number {
  if (!deletedAt) return KEEP_DAYS
  return Math.max(0, KEEP_DAYS - Math.floor((Date.now() - Date.parse(deletedAt)) / 86_400_000))
}

type Entry = { kind: 'space' | 'list' | 'reminder'; id: string; title: string; origin: string; mark: ReactNode; deleted: string | null; restore: (() => void) | null }

/** A row with "Restore" as a button and in its context menu, where one may restore it. */
function TrashRow({ entry }: { entry: Entry }) {
  const { t, i18n } = useTranslation()
  const menu = useTrashMenu(entry.restore)
  const left = daysLeft(entry.deleted)
  const warn = left <= WARN_DAYS
  return (
    <li {...menu} className="flex flex-wrap items-center gap-3.5 border-b border-ink-800 px-2.5 py-3" data-testid="trash-row" data-kind={entry.kind}>
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-ink-800 text-mist-300" aria-hidden>
        {entry.mark}
      </span>
      <span className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
        <span className="truncate text-[14.5px] font-semibold text-mist-100" title={entry.title}>
          {entry.title}
        </span>
        <span className="truncate text-[12.5px] text-mist-500">{entry.origin}</span>
      </span>
      <span className="flex-[0_0_150px] text-[12.5px] text-mist-500">{entry.deleted ? moment(entry.deleted, i18n.language) : ''}</span>
      <span className={'flex-[0_0_110px] text-[12.5px] ' + (warn ? 'text-warn-500' : 'text-mist-500')} data-testid="trash-left" data-warn={warn || undefined}>
        {t('trash.days', { count: left })}
      </span>
      <span className="flex w-[150px] justify-end">
        {entry.restore && (
          <button type="button" className="nt-btn nt-btn-ghost h-9 px-3 text-[13px]" aria-label={t('trash.restoreName', { name: entry.title })} onClick={entry.restore}>
            {t('trash.restore')}
          </button>
        )}
      </span>
    </li>
  )
}

export function TrashPage() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const { spaces, lists, reminders } = view.trash
  const entries: Entry[] = [
    ...spaces.map((s): Entry => ({
      kind: 'space',
      id: s.id,
      title: s.name,
      origin: t('trash.fromSpace'),
      mark: <Mark color={s.color} icon={s.icon} size={16} />,
      deleted: s.deleted_at,
      restore: s.role === 'manager' ? () => engine.trash('space', s.id, true) : null,
    })),
    ...lists.map((l): Entry => ({
      kind: 'list',
      id: l.id,
      title: l.name,
      origin: t('trash.fromList', { space: view.space(l.space_id)?.name ?? '' }),
      mark: <Mark color={l.color} icon={l.icon} size={16} />,
      deleted: l.deleted_at,
      restore: () => engine.trash('list', l.id, true),
    })),
    ...reminders.map((r): Entry => {
      const list = view.list(r.list_id)
      return {
        kind: 'reminder',
        id: r.id,
        title: r.title,
        origin: t('trash.fromTask', { list: list?.name ?? '', space: (list && view.space(list.space_id)?.name) ?? '' }),
        mark: <SquareCheck className="h-4 w-4" strokeWidth={2} />,
        deleted: r.deleted_at,
        restore: () => engine.trash('reminder', r.id, true),
      }
    }),
  ].sort((a, b) => (b.deleted ?? '').localeCompare(a.deleted ?? ''))

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="trash-title">
      <div className="flex min-h-full max-w-[1000px] flex-col gap-4 px-4 py-5 sm:px-7 sm:py-6" data-testid="trash-page">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="trash-title" className="text-2xl font-bold text-mist-100">
            {t('trash.title')}
          </h1>
          <span className="text-[13px] text-mist-500">{t('trash.hint')}</span>
        </div>
        {entries.length === 0 ? (
          <EmptyState icon={Trash2} title={t('trash.empty')} />
        ) : (
          <ul className="flex flex-col" aria-label={t('trash.title')} data-testid="trash-list">
            {entries.map((entry) => (
              <TrashRow key={`${entry.kind}-${entry.id}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
