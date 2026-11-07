/** Search over title, notes, tags and link of every task one sees; done ones on request. */
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { PageHead } from '../components/PageHead'
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
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="search-title" title={t('search.title')} search={false} />
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 focus-within:border-accent-500">
          <Search className="h-4 w-4 text-mist-500" aria-hidden />
          <input autoFocus value={query} onChange={(e) => set(e.target.value, withDone)} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} data-testid="search-field" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-mist-100 placeholder:text-mist-600 focus:outline-none" />
        </div>
        <label className="mb-4 flex items-center gap-2 text-xs text-mist-400">
          <input type="checkbox" checked={withDone} onChange={(e) => set(query, e.target.checked)} className="accent-accent-500" /> {t('search.withDone')}
        </label>
        {query.trim() && <p className="nt-sec mb-1.5 px-1">{t('search.found', { count: found.length })}</p>}
        {found.length > 0 && (
          <div className="nt-card overflow-hidden">
            <ReminderGroup spot={null} items={found} showDone={withDone} showList only={new Set(found.map((r) => r.id))} />
          </div>
        )}
      </div>
    </main>
  )
}
