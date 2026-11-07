/**
 * The head of the middle column (docs "Aussehen", "Web"): the title in the text's colour, bold, a grey line below it,
 * on a list its plaque in front. On the right the search, what the page adds (view, menu) and "+ New task". On a phone
 * a way back to the overview comes first.
 */
import { ChevronLeft, Plus, Search } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { NewTarget } from './DetailPane'
import { useShell } from './Shell'

export function PageHead({ id, title, sub, plaque, children, newTask = true, search = true, target }: { id: string; title: string; sub?: ReactNode; plaque?: ReactNode; children?: ReactNode; newTask?: boolean; search?: boolean; target?: NewTarget | null }) {
  const { t } = useTranslation()
  const shell = useShell()
  // N anywhere on the page makes the same new task as the button.
  const key = JSON.stringify(target ?? null)
  useEffect(() => {
    shell.registerTarget(target ?? null)
    return () => shell.registerTarget(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shell])
  return (
    <header className="mb-4">
      <BackToOverview />
      <div className="flex items-center gap-3">
        {plaque}
        <div className="min-w-0 flex-1">
          <h1 id={id} className="truncate text-2xl font-extrabold tracking-tight text-mist-100 sm:text-[26px]">
            {title}
          </h1>
          {sub && <p className="text-[13.5px] text-mist-500 sm:truncate">{sub}</p>}
        </div>
        {search && (
          <Link to="/search" className="nc-btn nc-btn-ghost px-2.5 font-normal sm:px-3" aria-label={t('search.title')} title={`${t('search.title')} (${t('keys.ctrl')} K)`}>
            <Search className="h-4 w-4" aria-hidden />
            <span className="hidden lg:inline">{t('search.title')}</span>
          </Link>
        )}
        {children}
        {newTask && (
          <button type="button" onClick={() => shell.newTask(target ?? undefined)} className="nc-btn nc-btn-accent px-2.5 sm:px-3.5" title={t('keys.new')} aria-label={t('reminder.new')} data-testid="new-reminder">
            <Plus className="h-4 w-4" strokeWidth={2.4} aria-hidden />
            <span className="hidden sm:inline">{t('reminder.new')}</span>
          </button>
        )}
      </div>
    </header>
  )
}

/** On a phone the overview is a page of its own; this leads back to it. */
export function BackToOverview() {
  const { t } = useTranslation()
  return (
    <Link to="/" className="-ml-1 mb-2 inline-flex items-center gap-0.5 text-sm font-medium text-accent-400 md:hidden" data-testid="back-to-overview">
      <ChevronLeft className="h-4 w-4" aria-hidden /> {t('overview.title')}
    </Link>
  )
}
