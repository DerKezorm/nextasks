/**
 * The head of the middle column, as nexnotes' `ListHead`: the symbol on a tinted tile, the title (22 px, bold, in the
 * text's colour), the number next to it, on the right what the page adds (view, menu), a small grey line below, a line
 * under it all; it stays at the top while the page scrolls. "+ New task" and the search stand in the sidebar, as in
 * nexnotes; the page tells it where a new task goes (`target`, N does the same). On a phone, where the sidebar is a
 * page of its own, a way back to the overview comes first, and "+ New task" is a large round button at the bottom
 * right, as nexnotes' "New note" there.
 */
import { ChevronLeft, Plus, type LucideIcon } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { NewTarget } from './DetailPane'
import { useShell } from './Shell'

export function PageHead({ id, title, count, sub, icon, children, newTask = true, target }: { id: string; title: string; count?: string; sub?: ReactNode; icon?: ReactNode; children?: ReactNode; newTask?: boolean; target?: NewTarget | null }) {
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
    <header className="-mx-1 mb-3 border-b border-ink-700 bg-ink-950 px-1 pt-1 pb-2.5 md:sticky md:top-0 md:z-10" data-testid="page-head">
      <BackToOverview />
      <div className="flex min-w-0 items-center gap-2 pt-0.5">
        {icon}
        <h1 id={id} className="min-w-0 truncate text-[22px] font-bold tracking-[-0.01em] text-mist-100" title={title}>
          {title}
        </h1>
        {count && (
          <span className="shrink-0 text-[13px] text-mist-600" data-testid="page-count">
            {count}
          </span>
        )}
        {children && <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>}
      </div>
      {sub && <p className="mt-1 min-w-0 truncate text-[12px] text-mist-600">{sub}</p>}
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

/** The symbol of a collection on its tile: petrol on the accent's wash (docs "Aussehen", principle 4). */
export function TileIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-accent-wash text-accent-400" data-mark-tile>
      <Icon className="h-[17px] w-[17px]" strokeWidth={2} aria-hidden />
    </span>
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
