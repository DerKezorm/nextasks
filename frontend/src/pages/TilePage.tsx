/**
 * The collections' pages: Today, Scheduled (by day), All (by space and list), Marked, Assigned to me, Done. A new
 * task typed here goes into the first list of "Private" and takes what the collection stands for (today, marked).
 */
import { useTranslation } from 'react-i18next'

import { EmptyState } from '../components/EmptyState'
import { Mark } from '../components/Mark'
import { PageHead, TileIcon } from '../components/PageHead'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup } from '../components/ReminderRow'
import { useShell } from '../components/Shell'
import { dayLabel, localDay, longDay } from '../lib/due'
import { TILE_LOOK } from '../lib/tileLook'
import { useView } from '../state/sync'
import { groupByDay, tileItems, type Tile } from '../sync/tiles'
import type { Data, Reminder } from '../sync/types'

/** Top-level rows only: a subtask whose parent shows too appears under it. */
// eslint-disable-next-line react-refresh/only-export-components
export function tops(items: Reminder[]): Reminder[] {
  const shown = new Set(items.map((r) => r.id))
  return items.filter((r) => !r.parent_id || !shown.has(r.parent_id))
}

export function TilePage({ tile }: { tile: Tile }) {
  const { t, i18n } = useTranslation()
  const view = useView()
  const shell = useShell()
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
        <h2 className={'nt-sec mb-1 flex items-baseline gap-1.5 px-3 ' + (day < today ? 'text-late' : '')}>
          <span>{dayLabel(day, today, i18n.language, t)}</span>
          <span className="font-medium tracking-normal normal-case">· {longDay(day, i18n.language)}</span>
          <span className="font-medium tracking-normal normal-case tabular-nums">· {group.length}</span>
        </h2>
        <ReminderGroup spot={null} items={tops(group)} showDone={false} showList only={only} />
      </section>
    ))
  } else if (tile === 'all' || tile === 'flagged') {
    const lists = [...new Set(items.map((r) => r.list_id))]
    body = lists.map((listId) => {
      const list = view.list(listId)!
      const group = items.filter((r) => r.list_id === listId)
      return (
        <section key={listId} className="mb-5" aria-label={list.name}>
          <h2 className="nt-sec mb-1 flex items-center gap-1.5 px-3">
            <Mark color={list.color} icon={list.icon} size={12} /> <span className="truncate">{list.name}</span>
            <span className="truncate font-medium tracking-normal normal-case">· {view.space(list.space_id)?.name}</span>
            <span className="shrink-0 font-medium tracking-normal normal-case tabular-nums">· {group.length}</span>
          </h2>
          <ReminderGroup spot={null} items={tops(group)} showDone={false} only={only} />
        </section>
      )
    })
  } else
    body = items.length > 0 && (
      <div className="mb-5">
        <ReminderGroup spot={null} items={tops(items)} showDone={tile === 'done'} showList only={only} footer={quick} />
      </div>
    )

  // Grouped pages and an empty one keep the quick entry in a card of its own below.
  const apart = quick && (tile === 'scheduled' || tile === 'all' || tile === 'flagged' || items.length === 0)

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="tile-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="tile-title" target={target} title={t(`tiles.${tile}`)} count={tile === 'done' ? t('tiles.subDone', { count: items.length }) : t('list.open', { count: items.length })} sub={t('tiles.everywhere')} icon={<TileIcon icon={TILE_LOOK[tile].icon} />} />
        {items.length === 0 && (
          <EmptyState icon={TILE_LOOK[tile].icon} title={t(`tiles.empty.${tile}`)} text={tile === 'done' ? undefined : t('tiles.emptyText')} action={tile === 'done' || !target ? undefined : t('reminder.new')} onAction={() => shell.newTask(target ?? undefined)} />
        )}
        {body}
        {apart && <div>{quick}</div>}
      </div>
    </main>
  )
}
