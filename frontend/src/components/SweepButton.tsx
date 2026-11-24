/**
 * The way into the look through ("Rückschau") in the head of "All" and "Someday": only while tasks wait for it, with
 * their number. On a phone the symbol and the number.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { SWEEP_ICON as Icon, useSweepCount } from '../lib/sweep'

export function SweepButton() {
  const { t } = useTranslation()
  const count = useSweepCount()
  if (!count) return null
  return (
    <Link
      to="/sweep"
      className="flex h-8 items-center gap-1.5 rounded-full border border-ink-700 px-2.5 text-[13px] font-semibold text-mist-100 hover:bg-ink-800"
      aria-label={t('sweep.button', { count })}
      title={t('sweep.button', { count })}
      data-testid="sweep-button"
    >
      <Icon className="h-4 w-4 text-petrol" strokeWidth={2} aria-hidden />
      <span className="max-sm:hidden">{t('sweep.title')}</span>
      <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-wash px-1.5 text-[11px] leading-none font-bold text-accent-400 tabular-nums">{count}</span>
    </Link>
  )
}
