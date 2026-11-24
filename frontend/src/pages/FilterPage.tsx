/**
 * The page of an own filter: its plaque and name, the tasks it finds in one card in the reading column as a collection shows them (open ones
 * by due date, then completed ones newest first), and a button to change it. "+ New task" goes into the list the
 * filter names when it names exactly one, else where the quick entry goes. A filter one hid opens all the same.
 */
import { Filter as FilterIcon, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { QuietEmpty } from '../components/EmptyState'
import { MarkTile } from '../components/Mark'
import { NotFound } from '../components/NotFound'
import { PageHead } from '../components/PageHead'
import { ReminderGroup } from '../components/ReminderRow'
import { useShell } from '../components/Shell'
import { localDay } from '../lib/due'
import { useSyncState, useView } from '../state/sync'
import { filterItems, readRules } from '../sync/tiles'
import { tops } from './TilePage'

export function FilterPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const view = useView()
  const sync = useSyncState()
  const shell = useShell()
  const filter = view.filter(id)
  if (!filter) return sync.loaded ? <NotFound text={t('notFound.filter')} /> : <main className="flex-1" />

  const rules = readRules(filter.rules)
  const items = filterItems(view, filter.rules, localDay())
  const only = new Set(items.map((r) => r.id))
  const named = rules.lists.length === 1 && !rules.spaces.length ? view.list(rules.lists[0]) : undefined
  const list = named && !view.listInTrash(named) ? named : view.defaultList
  const target = list ? { spot: { list_id: list.id, section_id: null, parent_id: null }, defaults: rules.flagged ? { flagged: true } : {} } : null
  const sub = rules.state === 'open' ? t('list.open', { count: items.length }) : rules.state === 'completed' ? t('tiles.subDone', { count: items.length }) : t('filter.subAll', { count: items.length })

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="filter-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="filter-title" target={target} title={filter.name} count={sub} sub={t('filter.section')} icon={<MarkTile color={filter.color} icon={filter.icon} />}>
          <button type="button" onClick={() => shell.editFilter(filter.id)} className="nt-icon-btn" aria-label={t('filter.edit')} title={t('filter.edit')} data-testid="edit-filter">
            <Pencil className="h-4 w-4" strokeWidth={1.8} aria-hidden />
          </button>
        </PageHead>
        <div className="nt-read">
          {items.length === 0 ? (
            <QuietEmpty icon={FilterIcon} title={t('filter.empty')} text={t('filter.emptyText')} />
          ) : (
            <ReminderGroup spot={null} items={tops(items)} showDone={rules.state !== 'open'} showList only={only} />
          )}
        </div>
      </div>
    </main>
  )
}
