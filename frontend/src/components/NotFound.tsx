import { SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { BackToOverview } from './PageHead'

/**
 * A link to something that is not there (any more), or not for this account, as nexnotes says it: one sentence with
 * the way back, instead of showing something else under the wrong address.
 */
export function NotFound({ text }: { text?: string }) {
  const { t } = useTranslation()
  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto px-4 py-5">
      <BackToOverview />
      <div data-testid="not-found" className="mx-auto mt-10 max-w-md rounded-[12px] border border-ink-700 bg-ink-850 p-6 text-center">
        <SearchX className="mx-auto h-6 w-6 text-mist-500" strokeWidth={1.8} aria-hidden />
        <p className="mt-3 text-sm text-mist-300">{text ?? t('notFound.page')}</p>
        <Link to="/" className="nt-btn nt-btn-accent mt-4">
          {t('notFound.home')}
        </Link>
      </div>
    </main>
  )
}
