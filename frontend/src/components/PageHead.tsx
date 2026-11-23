/**
 * The head of the middle column (docs "Aussehen", "Web"): the title in the text's colour, bold, a grey line below it,
 * on a list its plaque in front, on the right what the page adds (view, menu). "+ New task" and the search stand in the
 * sidebar, as in nexnotes; the page tells it where a new task goes (`target`, N does the same). On a phone, where the
 * sidebar is a page of its own, a way back to the overview comes first, and "+ New task" is a large round button at
 * the bottom right, as nexnotes' "New note" there.
 */
import { ChevronLeft, Plus } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { NewTarget } from './DetailPane'
import { useShell } from './Shell'

export function PageHead({ id, title, sub, plaque, children, newTask = true, target }: { id: string; title: string; sub?: ReactNode; plaque?: ReactNode; children?: ReactNode; newTask?: boolean; target?: NewTarget | null }) {
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
        {children}
      </div>
      {newTask && (
        <button
          type="button"
          onClick={() => shell.newTask(target ?? undefined)}
          aria-label={t('reminder.new')}
          data-testid="phone-new-reminder"
          className="nt-safe-bottom fixed right-4 bottom-7 z-20 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent-500 text-on-accent shadow-lg md:hidden"
        >
          <Plus className="h-[22px] w-[22px]" strokeWidth={2.6} aria-hidden />
        </button>
      )}
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
