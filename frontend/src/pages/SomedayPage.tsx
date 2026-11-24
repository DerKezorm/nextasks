/**
 * "Someday": the open tasks without a date, in a card per list as "All" shows them (`lib/someday.ts`). A list one
 * ticks off as a whole (groceries, packing) can be left out here on this device, from its card's head; below the cards
 * the lists left out, to take them in again. A task typed here goes into the first list of "Private", without a date.
 * The head leads to the look through while tasks wait for it.
 */
import { EyeOff, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { QuietEmpty } from '../components/EmptyState'
import { Plaque } from '../components/Mark'
import { PageHead, TileIcon } from '../components/PageHead'
import { QuickEntry } from '../components/QuickEntry'
import { SweepButton } from '../components/SweepButton'
import { SOMEDAY_ICON, somedayItems, useSomedayLists } from '../lib/someday'
import { useView } from '../state/sync'
import type { List } from '../sync/types'
import { ListCards } from './TilePage'

export function SomedayPage() {
  const { t } = useTranslation()
  const view = useView()
  const [leftOut, setLeftOut] = useSomedayLists()
  const items = somedayItems(view, leftOut)
  const only = new Set(items.map((r) => r.id))
  const first = view.defaultList
  const target = first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: {} } : null
  const away = leftOut.map((id) => view.list(id)).filter((list): list is List => !!list && !view.listInTrash(list))
  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="someday-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="someday-title" target={target} title={t('someday.title')} count={t('list.open', { count: items.length })} sub={t('someday.sub')} icon={<TileIcon icon={SOMEDAY_ICON} />}>
          <SweepButton />
        </PageHead>
        <div className="nt-read space-y-4">
          {items.length === 0 && <QuietEmpty icon={SOMEDAY_ICON} title={t('someday.empty')} text={t('someday.emptyLine')} />}
          <ListCards
            items={items}
            only={only}
            extra={(list) => (
              <button type="button" className="nt-icon-btn h-7 w-7" onClick={() => setLeftOut(list.id, true)} aria-label={t('someday.leaveOut', { name: list.name })} title={t('someday.leaveOut', { name: list.name })} data-testid="someday-leave-out">
                <EyeOff className="h-4 w-4" strokeWidth={1.9} aria-hidden />
              </button>
            )}
          />
          <div className="nt-group">
            <QuickEntry spot={null} label={t('quick.placeholderPrivate', { list: first?.name ?? '' })} />
          </div>
          {away.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-mist-500" data-testid="someday-left-out">
              <span className="mr-0.5">{t('someday.leftOut')}</span>
              {away.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => setLeftOut(list.id, false)}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-ink-700 pr-2.5 pl-1.5 text-[12.5px] text-mist-300 hover:bg-ink-800 hover:text-mist-100"
                  title={t('someday.takeIn', { name: list.name })}
                  aria-label={t('someday.takeIn', { name: list.name })}
                >
                  <Plaque color={list.color} icon={list.icon} size={16} />
                  {list.name}
                  <Plus className="h-3.5 w-3.5 text-petrol" strokeWidth={2.4} aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
