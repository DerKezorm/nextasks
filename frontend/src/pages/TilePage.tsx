/**
 * The collections' pages: Today, Scheduled (by day), All (by space and list), Marked, Assigned to me, Done. A new
 * task typed here goes into the first list of "Private" and takes what the collection stands for (today, marked).
 */
import { useTranslation } from 'react-i18next'

import { ListDot } from '../components/Badge'
import { PageHead } from '../components/PageHead'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup } from '../components/ReminderRow'
import { dayLabel, localDay, longDay } from '../lib/due'
import { useView } from '../state/sync'
import { groupByDay, tileItems, type Tile } from '../sync/tiles'
import type { Data, Reminder } from '../sync/types'

/** Top-level rows only: a subtask whose parent shows too appears under it. */
function tops(items: Reminder[]): Reminder[] {
  const shown = new Set(items.map((r) => r.id))
  return items.filter((r) => !r.parent_id || !shown.has(r.parent_id))
}

export function TilePage({ tile }: { tile: Tile }) {
  const { t, i18n } = useTranslation()
  const view = useView()
  const today = localDay()
  const items = tileItems(view, tile, today)
  const only = new Set(items.map((r) => r.id))
  const defaults: Data | null = tile === 'today' || tile === 'scheduled' ? { due_date: today, due_time: null, repeat: null, repeat_from: 'due' } : tile === 'flagged' ? { flagged: true } : tile === 'all' ? {} : null
  // "+ New task" goes where the quick entry goes, with what the collection stands for (me only where others are).
  const first = view.defaultList
  const firstSpace = first ? view.space(first.space_id) : undefined
  const startWith: Data = tile === 'today' || tile === 'scheduled' ? { due_date: today, due_time: null, repeat: null, repeat_from: 'due' } : tile === 'flagged' ? { flagged: true } : tile === 'assigned' && firstSpace && !firstSpace.private ? { assignees: [view.me] } : {}
  const target = first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: startWith } : null
  const quick = defaults && <QuickEntry spot={null} defaults={defaults} label={t('quick.placeholderPrivate', { list: first?.name ?? '' })} />

  let body
  if (tile === 'scheduled') {
    body = groupByDay(items).map(({ day, items: group }) => (
      <section key={day} className="mb-5" aria-label={longDay(day, i18n.language)}>
        <h2 className={'nt-sec mb-1.5 flex items-baseline gap-2 px-1 ' + (day < today ? 'text-bad-500' : '')}>
          <span>{dayLabel(day, today, i18n.language, t)}</span>
          <span className="font-semibold tracking-normal normal-case opacity-80">{longDay(day, i18n.language)}</span>
          <span className="ml-auto tabular-nums">{group.length}</span>
        </h2>
        <div className="nt-card overflow-hidden">
          <ReminderGroup spot={null} items={tops(group)} showDone={false} showList only={only} />
        </div>
      </section>
    ))
  } else if (tile === 'all' || tile === 'flagged') {
    const lists = [...new Set(items.map((r) => r.list_id))]
    body = lists.map((listId) => {
      const list = view.list(listId)!
      const group = items.filter((r) => r.list_id === listId)
      return (
        <section key={listId} className="mb-5" aria-label={list.name}>
          <h2 className="nt-sec mb-1.5 flex items-center gap-2 px-1">
            <ListDot color={list.color} /> <span className="truncate">{list.name}</span>
            <span className="truncate font-semibold tracking-normal normal-case opacity-80">{view.space(list.space_id)?.name}</span>
            <span className="ml-auto tabular-nums">{group.length}</span>
          </h2>
          <div className="nt-card overflow-hidden">
            <ReminderGroup spot={null} items={tops(group)} showDone={false} only={only} />
          </div>
        </section>
      )
    })
  } else
    body = items.length > 0 && (
      <div className="nt-card mb-5 overflow-hidden">
        <ReminderGroup spot={null} items={tops(items)} showDone={tile === 'done'} showList only={only} footer={quick} />
      </div>
    )

  // Grouped pages and an empty one keep the quick entry in a card of its own below.
  const apart = quick && (tile === 'scheduled' || tile === 'all' || tile === 'flagged' || items.length === 0)

  return (
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="tile-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="tile-title" target={target} title={t(`tiles.${tile}`)} sub={tile === 'done' ? t('tiles.subDone', { count: items.length }) : t('tiles.sub', { count: items.length })} />
        {items.length === 0 && <p className="px-1 pb-4 text-sm text-mist-500">{t(`tiles.empty.${tile}`)}</p>}
        {body}
        {apart && <div className="nt-card overflow-hidden">{quick}</div>}
      </div>
    </main>
  )
}
