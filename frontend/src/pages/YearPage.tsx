/**
 * "Your year" (`/review/year/<year>`): the card of a calendar year (`components/YearCard.tsx`) from every space one
 * is in (`GET /api/stats?range=year&year=`), with "Save as picture". The review offers it from 1 December to
 * 31 January; the address works any time. A year without anything done shows a quiet empty state.
 */
import { ChevronLeft, Download, Sparkles } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import { EmptyState } from '../components/EmptyState'
import { NotFound } from '../components/NotFound'
import { CARD_HEIGHT, CARD_WIDTH, YearCard } from '../components/YearCard'
import { errorText } from '../lib/errors'
import { showNotice } from '../lib/notice'
import { savePicture } from '../lib/picture'
import { useStats } from '../lib/stats'
import { ReviewPlaque } from './ReviewPage'

export function YearPage() {
  const { year = '' } = useParams()
  if (!/^\d{4}$/.test(year)) return <NotFound />
  return <YearBody key={year} year={Number(year)} />
}

function YearBody({ year }: { year: number }) {
  const { t } = useTranslation()
  const load = useStats('all', 'year', year)
  const card = useRef<SVGSVGElement>(null)
  const [busy, setBusy] = useState(false)
  const done = load.state === 'ready' && !!load.stats.year?.completed

  const save = async () => {
    if (!card.current) return
    setBusy(true)
    try {
      await savePicture(card.current, CARD_WIDTH, CARD_HEIGHT, `nextasks-${year}.png`)
    } catch {
      showNotice({ text: t('review.year.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="nt-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="year-title">
      <div className="flex max-w-[1280px] flex-col gap-4 px-4 py-5 sm:px-7 sm:py-6" data-testid="year-page">
        <header className="-mx-1 border-b border-ink-700 bg-ink-950 px-1 pt-1 pb-3" data-testid="page-head">
          <Link to="/review" className="-ml-1 mb-2 inline-flex items-center gap-0.5 text-sm font-medium text-accent-400" data-testid="year-back">
            <ChevronLeft className="h-4 w-4" aria-hidden /> {t('review.year.back')}
          </Link>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <ReviewPlaque />
              <h1 id="year-title" className="truncate text-[22px] font-bold tracking-[-0.01em] text-mist-100">
                {t('review.year.title', { year })}
              </h1>
            </div>
            {done && (
              <button type="button" className="nt-btn nt-btn-accent h-9 max-md:w-full" onClick={() => void save()} disabled={busy} data-testid="year-save">
                <Download className="h-4 w-4" strokeWidth={2.2} aria-hidden />
                {t('review.year.save')}
              </button>
            )}
          </div>
        </header>

        {load.state === 'loading' && (
          <p className="text-sm text-mist-500" role="status">
            {t('review.loading')}
          </p>
        )}
        {load.state === 'failed' && (
          <p className="nt-problem" role="alert">
            {errorText(load.code)}
          </p>
        )}
        {load.state === 'ready' &&
          (done ? (
            <div className="w-full max-w-[620px]">
              <YearCard ref={card} stats={load.stats} />
            </div>
          ) : (
            <EmptyState icon={Sparkles} title={t('review.year.empty', { year })} text={t('review.year.emptyText')} />
          ))}
      </div>
    </main>
  )
}
