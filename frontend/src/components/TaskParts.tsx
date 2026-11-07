/**
 * The small parts every task shows the same way (docs "Aussehen"): the tick box, the priority as a word on a plaque,
 * the bookmark of a marked task.
 */
import { Bookmark, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** The tick box: a rounded square, filled petrol with a white tick once done. */
export function TickBox({ done, title, onToggle, small = false, className = '' }: { done: boolean; title: string; onToggle: () => void; small?: boolean; className?: string }) {
  const { t } = useTranslation()
  return (
    <button type="button" role="checkbox" aria-checked={done} aria-label={t(done ? 'reminder.reopen' : 'reminder.complete', { title })} onClick={onToggle} className={'nt-box ' + (small ? 'nt-box-sm ' : '') + className}>
      {done && <Check className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} strokeWidth={3.2} aria-hidden />}
    </button>
  )
}

/** "low", "medium", "high" on a grey, amber or red plaque; nothing for no priority. */
export function PriorityPlaque({ priority }: { priority: number }) {
  const { t } = useTranslation()
  if (priority < 1 || priority > 3) return null
  return (
    <span className="nt-prio" style={{ background: `var(--color-prio-${priority})` }} title={t('reminder.priorityIs', { priority: t(`priority.${priority}`) })} data-testid="priority">
      {t(`priority.${priority}`)}
    </span>
  )
}

/** The bookmark of a marked task, filled petrol. */
export function MarkedSign() {
  const { t } = useTranslation()
  return <Bookmark className="h-4 w-4 shrink-0 fill-current text-petrol" aria-label={t('reminder.flagged')} role="img" />
}
