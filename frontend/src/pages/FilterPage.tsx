/**
 * The page of an own filter: its plaque and name, the tasks it finds in one card as a collection shows them (open ones
 * by due date, then completed ones newest first), and a button to change it. "+ New task" goes into the list the
 * filter names when it names exactly one, else where the quick entry goes. A filter one hid opens all the same.
 */
import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useParams } from 'react-router-dom'

import { Badge } from '../components/Badge'
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
  if (!filter) return sync.loaded ? <Navigate to="/today" replace /> : <main className="flex-1" />

  const rules = readRules(filter.rules)
  const items = filterItems(view, filter.rules, localDay())
  const only = new Set(items.map((r) => r.id))
  const named = rules.lists.length === 1 && !rules.spaces.length ? view.list(rules.lists[0]) : undefined
  const list = named && !view.listInTrash(named) ? named : view.defaultList
  const target = list ? { spot: { list_id: list.id, section_id: null, parent_id: null }, defaults: rules.flagged ? { flagged: true } : {} } : null
  const sub = rules.state === 'open' ? t('list.open', { count: items.length }) : rules.state === 'completed' ? t('tiles.subDone', { count: items.length }) : t('filter.subAll', { count: items.length })

  return (
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="filter-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="filter-title" target={target} title={filter.name} sub={sub} plaque={<Badge color={filter.color} icon={filter.icon} size="lg" />}>
          <button type="button" onClick={() => shell.editFilter(filter.id)} className="nc-btn nc-btn-ghost px-2.5 font-normal sm:px-3" aria-label={t('filter.edit')} title={t('filter.edit')} data-testid="edit-filter">
            <Pencil className="h-4 w-4" aria-hidden />
            <span className="hidden lg:inline">{t('filter.edit')}</span>
          </button>
        </PageHead>
        {items.length === 0 ? (
          <p className="px-1 pb-4 text-sm text-mist-500">{t('filter.empty')}</p>
        ) : (
          <div className="nt-card mb-5 overflow-hidden">
            <ReminderGroup spot={null} items={tops(items)} showDone={rules.state !== 'open'} showList only={only} />
          </div>
        )}
      </div>
    </main>
  )
}
