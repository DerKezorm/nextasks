/** Search over title, notes, tags and link of every task one sees; done ones on request. */
import { Search, SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { EmptyState } from '../components/EmptyState'
import { PageHead, TileIcon } from '../components/PageHead'
import { ReminderGroup } from '../components/ReminderRow'
import { search } from '../lib/actions'
import { useView } from '../state/sync'
import { byPlace } from '../sync/tiles'

export function SearchPage() {
  const { t } = useTranslation()
  const view = useView()
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const withDone = params.get('done') === '1'
  const found = search(view, query, withDone).sort(byPlace(view))
  const set = (q: string, done: boolean) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (q) next.set('q', q)
        else next.delete('q')
        if (done) next.set('done', '1')
        else next.delete('done')
        return next
      },
      { replace: true },
    )
  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="search-title" title={t('search.title')} icon={<TileIcon icon={Search} />} />
        <div className="nt-read">
          <label className="relative mb-3 block">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500" aria-hidden />
            <input autoFocus value={query} onChange={(e) => set(e.target.value, withDone)} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} data-testid="search-field" className="nt-field pl-9" />
          </label>
          <label className="mb-4 flex items-center gap-2 px-1 text-sm text-mist-300">
            <input type="checkbox" checked={withDone} onChange={(e) => set(query, e.target.checked)} className="h-4 w-4 accent-accent-500" /> {t('search.withDone')}
          </label>
          {query.trim() && <p className="nt-sec mb-1 px-3">{t('search.found', { count: found.length })}</p>}
          {query.trim() && found.length === 0 && <EmptyState icon={SearchX} title={t('search.none')} text={t('search.noneText')} />}
          {found.length > 0 && <ReminderGroup spot={null} items={found} showDone={withDone} showList only={new Set(found.map((r) => r.id))} />}
        </div>
      </div>
    </main>
  )
}
