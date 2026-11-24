/**
 * The collections' pages: Today, Scheduled (by day, as a list or as day columns), All (by space and list), Marked,
 * Assigned to me, Done. The tasks stand in cards in a column one reads at a glance: one card for the collection, or a
 * card per day (Scheduled) or per list (All, Marked) with its head inside. A new task typed here goes into the first
 * list of "Private" and takes what the collection stands for (today, marked). An empty collection says so in a quiet
 * line (Today: how many are due tomorrow). The day columns are for wide windows; on a phone "Scheduled" is always the
 * list.
 */
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { CardHead } from '../components/CardHead'
import { DayBoard, DayNav, ScheduledViewMenu } from '../components/DayBoard'
import { QuietEmpty } from '../components/EmptyState'
import { Plaque } from '../components/Mark'
import { PageHead, TileIcon } from '../components/PageHead'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup } from '../components/ReminderRow'
import { useDayPaging, useScheduledLook } from '../lib/dayColumns'
import { dayLabel, localDay, longDay } from '../lib/due'
import { usePhone } from '../lib/phone'
import { TILE_LOOK } from '../lib/tileLook'
import { useView } from '../state/sync'
import { addDays } from '../sync/repeat'
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
  const phone = usePhone()
  const [look, setLook] = useScheduledLook()
  const paging = useDayPaging(tile)
  const today = localDay()
  const items = tileItems(view, tile, today)
  const switchable = tile === 'scheduled' && !phone
  const columns = switchable && look === 'columns'
  const only = new Set(items.map((r) => r.id))
  const defaults: Data | null = tile === 'today' || tile === 'scheduled' ? { due_date: today, due_time: null, repeat: null, repeat_from: 'due' } : tile === 'flagged' ? { flagged: true } : tile === 'all' ? {} : null
  // "+ New task" goes where the quick entry goes, with what the collection stands for (me only where others are).
  const first = view.defaultList
  const firstSpace = first ? view.space(first.space_id) : undefined
  const startWith: Data = tile === 'today' || tile === 'scheduled' ? { due_date: today, due_time: null, repeat: null, repeat_from: 'due' } : tile === 'flagged' ? { flagged: true } : tile === 'assigned' && firstSpace && !firstSpace.private ? { assignees: [view.me] } : {}
  const target = first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: startWith } : null
  const quick = defaults && <QuickEntry spot={null} defaults={defaults} label={t('quick.placeholderPrivate', { list: first?.name ?? '' })} />

  let body
  if (columns) body = <DayBoard items={items} today={today} paging={paging} />
  else if (tile === 'scheduled') {
    body = groupByDay(items).map(({ day, items: group }) => (
      <section key={day} aria-label={longDay(day, i18n.language)}>
        <ReminderGroup
          spot={null}
          items={tops(group)}
          showDone={false}
          showList
          only={only}
          head={
            <CardHead count={group.length} tone={day < today ? 'late' : day === today ? 'today' : undefined}>
              <span className="shrink-0">{dayLabel(day, today, i18n.language, t)}</span>
              <span className="truncate font-medium tracking-normal normal-case">· {longDay(day, i18n.language)}</span>
            </CardHead>
          }
        />
      </section>
    ))
  } else if (tile === 'all' || tile === 'flagged') {
    const lists = [...new Set(items.map((r) => r.list_id))]
    body = lists.map((listId) => {
      const list = view.list(listId)!
      const group = items.filter((r) => r.list_id === listId)
      return (
        <section key={listId} aria-label={list.name}>
          <ReminderGroup
            spot={null}
            items={tops(group)}
            showDone={false}
            only={only}
            head={
              <CardHead
                count={group.length}
                action={
                  <Link to={`/lists/${list.id}`} className="nt-icon-btn h-7 w-7" aria-label={t('tiles.openList', { name: list.name })} title={t('tiles.openList', { name: list.name })}>
                    <ArrowRight className="h-4 w-4" strokeWidth={1.9} aria-hidden />
                  </Link>
                }
              >
                <span className="self-center">
                  <Plaque color={list.color} icon={list.icon} size={16} />
                </span>
                <span className="truncate">{list.name}</span>
                <span className="truncate font-medium tracking-normal normal-case">· {view.space(list.space_id)?.name}</span>
              </CardHead>
            }
          />
        </section>
      )
    })
  } else
    body = items.length > 0 && <ReminderGroup spot={null} items={tops(items)} showDone={tile === 'done'} showList only={only} footer={quick} />

  // Grouped pages and an empty one keep the quick entry in a card of its own below.
  const apart = quick && !columns && (tile === 'scheduled' || tile === 'all' || tile === 'flagged' || items.length === 0)
  // Today without anything left: how many wait for tomorrow.
  const tomorrow = tile === 'today' && items.length === 0 ? view.visible.filter((r) => !r.completed_at && r.due_date === addDays(today, 1)).length : 0

  return (
    // The day columns scroll in a box of their own below the head, so their heads can stay at its top.
    <main className={'min-w-0 flex-1 ' + (columns ? 'flex flex-col overflow-hidden' : 'nt-scroll overflow-y-auto')} aria-labelledby="tile-title">
      <div className={'px-4 py-5 sm:px-7 sm:py-6 ' + (columns ? 'flex min-h-0 flex-1 flex-col pb-0 sm:pb-0' : '')}>
        <PageHead id="tile-title" target={target} title={t(`tiles.${tile}`)} count={tile === 'done' ? t('tiles.subDone', { count: items.length }) : t('list.open', { count: items.length })} sub={t('tiles.everywhere')} icon={<TileIcon icon={TILE_LOOK[tile].icon} />}>
          {switchable && (
            <>
              {columns && <DayNav items={items} today={today} paging={paging} />}
              <ScheduledViewMenu look={look} onLook={setLook} />
            </>
          )}
        </PageHead>
        {columns ? (
          body
        ) : (
          <div className="nt-read space-y-4">
            {items.length === 0 && (
              <QuietEmpty
                icon={TILE_LOOK[tile].icon}
                title={t(`tiles.empty.${tile}`)}
                text={tile === 'today' ? (tomorrow ? t('tiles.tomorrow', { count: tomorrow }) : t('tiles.tomorrowNone')) : t(`tiles.emptyLine.${tile}`)}
              />
            )}
            {body}
            {apart && <div className="nt-group">{quick}</div>}
          </div>
        )}
      </div>
    </main>
  )
}
