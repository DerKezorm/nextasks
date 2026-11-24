/**
 * "Someday": the open tasks without a date, in a card per list as "All" shows them (`lib/someday.ts`). A task typed
 * here goes into the first list of "Private", without a date. The head leads to the look through while tasks wait
 * for it.
 */
import { useTranslation } from 'react-i18next'

import { QuietEmpty } from '../components/EmptyState'
import { PageHead, TileIcon } from '../components/PageHead'
import { QuickEntry } from '../components/QuickEntry'
import { SweepButton } from '../components/SweepButton'
import { SOMEDAY_ICON, somedayItems } from '../lib/someday'
import { useView } from '../state/sync'
import { ListCards } from './TilePage'

export function SomedayPage() {
  const { t } = useTranslation()
  const view = useView()
  const items = somedayItems(view)
  const only = new Set(items.map((r) => r.id))
  const first = view.defaultList
  const target = first ? { spot: { list_id: first.id, section_id: null, parent_id: null }, defaults: {} } : null
  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="someday-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="someday-title" target={target} title={t('someday.title')} count={t('list.open', { count: items.length })} sub={t('someday.sub')} icon={<TileIcon icon={SOMEDAY_ICON} />}>
          <SweepButton />
        </PageHead>
        <div className="nt-read space-y-4">
          {items.length === 0 && <QuietEmpty icon={SOMEDAY_ICON} title={t('someday.empty')} text={t('someday.emptyLine')} />}
          <ListCards items={items} only={only} />
          <div className="nt-group">
            <QuickEntry spot={null} label={t('quick.placeholderPrivate', { list: first?.name ?? '' })} />
          </div>
        </div>
      </div>
    </main>
  )
}
